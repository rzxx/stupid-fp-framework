import { executeAction } from "./action";
import { Effect } from "./effect";
import type { JsonValue } from "./json";
import { actionHooks, resourceHooks, routeHooks, sessionHooks, traceHooks } from "./plugin";
import { screenRouteDefinition, screenRoutePattern, type Program } from "./program";
import { resourceKeyId, serializeResourceKey, type ResourceKey } from "./resource";
import type { ProjectionRegionSnapshot } from "./projection";
import {
  MemoryRuntimeStore,
  RuntimeStoreError,
  runtimeStoreError,
  type RuntimeStore,
} from "./store";
import {
  type ClientEnvelope,
  type ProjectionPatchEnvelope,
  type ResumeResult,
  type ServerEnvelope,
} from "./stream";
import { SessionStore, type Session, type SessionSnapshot } from "./session";
import { TraceStore, type TraceSnapshot } from "./trace";

export type RuntimeResult<TProjection> = {
  envelopes: ServerEnvelope<TProjection, TraceSnapshot>[];
};

export type AffectedRegion = {
  sessionId: string;
  regions: ProjectionRegionSnapshot[];
};

export type Runtime<
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = {
  connect: (
    envelope: Extract<ClientEnvelope<TSessionMessage | TActionMessage>, { type: "connect" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  receive: (
    envelope: Extract<ClientEnvelope<TSessionMessage | TActionMessage>, { type: "message" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  traces: TraceStore;
  affectedRegions: (keys: readonly ResourceKey[]) => AffectedRegion[];
  invalidate: (keys: readonly ResourceKey[]) => Promise<RuntimeResult<TProjection>>;
};

export type RuntimeOptions<TSessionState, TProjection> = {
  store?: RuntimeStore<TSessionState, TProjection, TraceSnapshot>;
};

export function createRuntime<
  R,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  program: Program<R, TSessionState, TSessionMessage, TActionMessage, TProjection>,
  options?: RuntimeOptions<TSessionState, TProjection>,
): Runtime<TSessionMessage, TActionMessage, TProjection> {
  const sessions = new SessionStore(program.session);
  const traces = new TraceStore();
  const actionPluginHooks = actionHooks(program.plugins);
  const resourcePluginHooks = resourceHooks(program.plugins);
  const routePluginHooks = routeHooks(program.plugins);
  const sessionPluginHooks = sessionHooks(program.plugins);
  const tracePluginHooks = traceHooks(program.plugins);
  const store =
    options?.store ?? new MemoryRuntimeStore<TSessionState, TProjection, TraceSnapshot>();

  async function project(
    sessionId: string,
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(sessionId, trace);

    if ("error" in computed) {
      return {
        envelopes: [computed.error],
      };
    }

    const envelope = projectionEnvelope(computed, trace);
    if (trace) {
      traces.add(trace, "stream", "projection streamed", {
        projectionVersion: computed.projectionVersion,
        observedResources: computed.regions.flatMap((region) =>
          region.resources.map((resource) => resource.label),
        ),
      });
    }
    await persistEnvelope(computed.session, envelope);

    return {
      envelopes: [envelope],
    };
  }

  async function computeProjection(
    sessionId: string,
    trace?: TraceSnapshot,
  ): Promise<
    | {
        session: Session<TSessionState>;
        projection: TProjection;
        projectionVersion: number;
        regions: ProjectionRegionSnapshot[];
      }
    | {
        error: ServerEnvelope<TProjection, TraceSnapshot>;
      }
  > {
    const session = sessions.get(sessionId);

    if (!session) {
      return {
        error: { type: "error", sessionId, message: "Unknown session" },
      };
    }

    const screen = resolveScreen(session.route);

    if (!screen) {
      return {
        error: {
          type: "error",
          sessionId,
          message: `No screen registered for route: ${session.route}`,
        },
      };
    }

    let observed;

    try {
      observed = await program.resourceGraph.observe(() =>
        program.runtime.runPromise(
          screen.project(session, {
            resources: program.resourceGraph,
            traces: traces.scoped(sessionId),
            region: (id, read) => program.resourceGraph.region(id, read),
          }),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Projection failed";

      if (trace) {
        traces.fail(trace, message);
      }

      return {
        error: {
          type: "error",
          sessionId,
          traceId: trace?.traceId,
          message,
        },
      };
    }

    if (trace) {
      traces.add(trace, "projection", "resources observed", {
        resources: observed.observed.map((resource) => resource.label),
      });
      traces.add(trace, "projection", "projection recomputed");
    }

    const projection = observed.value;
    const projectionVersion = sessions.bumpProjection(session);
    session.observedRegions = observed.regions;

    return {
      session,
      projection,
      projectionVersion,
      regions: observed.regions,
    };
  }

  function projectionEnvelope(
    computed: {
      session: Session<TSessionState>;
      projection: TProjection;
      projectionVersion: number;
      regions: ProjectionRegionSnapshot[];
    },
    trace?: TraceSnapshot,
  ): ServerEnvelope<TProjection, TraceSnapshot> {
    return {
      type: "projection:update",
      sessionId: computed.session.sessionId,
      cursor: "",
      projectionVersion: computed.projectionVersion,
      projection: computed.projection,
      regions: computed.regions,
      causedByTraceId: trace?.traceId,
    };
  }

  return {
    traces,
    affectedRegions(keys) {
      return affectedRegions(sessions.list(), keys);
    },
    async invalidate(keys) {
      return refreshAffectedSessions(keys);
    },

    async connect(envelope) {
      const resolved = await resolveRoute(envelope.route, envelope.params);
      const connectRoute = resolved ?? {
        route: envelope.route,
        params: envelope.params,
      };
      const resume = envelope.resume
        ? await resolveResume(connectRoute.route, connectRoute.params, envelope.resume)
        : null;
      const session = resume?.snapshot
        ? sessions.restore(resume.snapshot)
        : sessions.create(connectRoute.route, connectRoute.params);
      await runSessionHooks(resume?.snapshot ? "restore" : "create", session);
      const connected: ServerEnvelope<TProjection, TraceSnapshot> = {
        type: "connected",
        sessionId: session.sessionId,
        cursor: "",
        resumed: Boolean(resume?.snapshot),
        resume: resume?.result ?? { status: "fresh" },
      };
      await persistEnvelope(session, connected);

      if (resume?.replay) {
        const replay =
          resume.replay[0]?.type === "projection:update"
            ? resume.replay
            : [...(await project(session.sessionId)).envelopes, ...resume.replay];

        return {
          envelopes: [connected, ...replay],
        };
      }

      const initial = await project(session.sessionId);

      return {
        envelopes: [connected, ...initial.envelopes],
      };
    },

    async receive(envelope) {
      const session = sessions.get(envelope.sessionId);

      if (!session) {
        return {
          envelopes: [
            {
              type: "error",
              sessionId: envelope.sessionId,
              message: "Unknown session",
            },
          ],
        };
      }

      const trace = traces.start(envelope.message.type, {
        scopeId: session.sessionId,
      });
      traces.add(trace, "message", "message received", {
        messageType: envelope.message.type,
      });

      const action = program.actionByType.get(envelope.message.type);

      if (!action) {
        if (!program.session.accepts(envelope.message)) {
          traces.fail(trace, `Unknown message type: ${envelope.message.type}`);
          return {
            envelopes: [
              {
                type: "error",
                sessionId: session.sessionId,
                traceId: trace.traceId,
                message: `Unknown message type: ${envelope.message.type}`,
              },
              await traceEnvelope(session, trace),
            ],
          };
        }

        sessions.update(session, envelope.message as TSessionMessage);
        await runSessionUpdateHooks(session, envelope.message as TSessionMessage);
        traces.add(trace, "session", `${envelope.message.type} applied`);
        const projected = await patchSession(session.sessionId, trace);
        if (trace.status !== "error") {
          traces.complete(trace);
        }

        return {
          envelopes: [...projected.envelopes, await traceEnvelope(session, trace)],
        };
      }

      const result = await executeAction(
        action,
        envelope.message as TActionMessage,
        program.runtime,
        traces,
        trace,
        actionPluginHooks,
      );

      traces.add(trace, "resource", "resources invalidated", {
        resources: result.invalidated.map((key) => serializeResourceKey(key).label),
      });
      const actionResult: ServerEnvelope<TProjection, TraceSnapshot> = {
        type: "action:result",
        sessionId: session.sessionId,
        cursor: "",
        traceId: trace.traceId,
        action: envelope.message.type.replace(/^action\./, ""),
        ok: result.ok,
        error: result.error,
        result: result.result,
      };
      await persistEnvelope(session, actionResult);
      const projected =
        result.ok && result.invalidated.length > 0
          ? await refreshAffectedSessions(result.invalidated, trace)
          : { envelopes: [] };

      if (result.ok && trace.status !== "error") {
        traces.complete(trace);
      }

      return {
        envelopes: [
          actionResult,
          ...projected.envelopes,
          ...(await traceEnvelopesFor(session, projected.envelopes, trace)),
        ],
      };
    },
  };

  async function persistEnvelope(
    session: Session<TSessionState>,
    envelope: ServerEnvelope<TProjection, TraceSnapshot>,
  ): Promise<void> {
    const cursor = await runStore(() => store.nextCursor());

    if (
      envelope.type === "connected" ||
      envelope.type === "projection:patch" ||
      envelope.type === "projection:update" ||
      envelope.type === "action:result" ||
      envelope.type === "trace:update"
    ) {
      envelope.cursor = cursor;
    }

    session.cursor = cursor;
    await runStore(() => store.appendEnvelope(session.sessionId, cursor, envelope));
    await runStore(() => store.saveSession(sessions.snapshot(session)));
  }

  async function traceEnvelope(
    session: Session<TSessionState>,
    trace: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    await runTraceHooks(trace);
    const envelope: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "trace:update",
      sessionId: session.sessionId,
      cursor: "",
      trace: traces.snapshot(trace, "browser"),
    };
    await persistEnvelope(session, envelope);
    return envelope;
  }

  async function traceEnvelopesFor(
    initiatingSession: Session<TSessionState>,
    envelopes: ServerEnvelope<TProjection, TraceSnapshot>[],
    trace: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>[]> {
    const targetSessionIds = new Set([initiatingSession.sessionId]);

    for (const envelope of envelopes) {
      if ("sessionId" in envelope && envelope.sessionId) {
        targetSessionIds.add(envelope.sessionId);
      }
    }

    const traceEnvelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const sessionId of targetSessionIds) {
      const targetSession = sessions.get(sessionId);

      if (targetSession) {
        traceEnvelopes.push(await traceEnvelope(targetSession, trace));
      }
    }

    return traceEnvelopes;
  }

  async function patchSession(
    sessionId: string,
    trace: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(sessionId, trace);

    if ("error" in computed) {
      return {
        envelopes: [computed.error],
      };
    }

    return {
      envelopes: [await patchEnvelope(computed, computed.regions, trace)],
    };
  }

  async function refreshAffectedSessions(
    keys: readonly ResourceKey[],
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const affected = affectedRegions(sessions.list(), keys);

    program.resourceGraph.invalidate(keys);
    await runResourceInvalidateHooks(keys);

    const envelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const affectedSession of affected) {
      const session = sessions.get(affectedSession.sessionId);

      if (!session) {
        continue;
      }

      if (trace) {
        traces.add(trace, "projection", "regions invalidated", {
          sessionId: affectedSession.sessionId,
          regions: affectedSession.regions.map((region) => region.id),
        });
      }

      const computed = await computeProjection(affectedSession.sessionId, trace);

      if ("error" in computed) {
        envelopes.push(computed.error);
        continue;
      }

      const invalidatedRegionIds = new Set(affectedSession.regions.map((region) => region.id));
      const regions = computed.regions.filter((region) => invalidatedRegionIds.has(region.id));
      const patchOrProjection = await patchEnvelope(computed, regions, trace);
      envelopes.push(patchOrProjection);
    }

    return { envelopes };
  }

  async function patchEnvelope(
    computed: {
      session: Session<TSessionState>;
      projection: TProjection;
      projectionVersion: number;
      regions: ProjectionRegionSnapshot[];
    },
    regions: ProjectionRegionSnapshot[],
    trace?: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    const patchRegions = patchableRegions(regions);

    if (!patchRegions) {
      const fallback = projectionEnvelope(computed, trace);
      await persistEnvelope(computed.session, fallback);

      if (trace) {
        traces.add(trace, "stream", "projection fallback streamed", {
          sessionId: computed.session.sessionId,
          projectionVersion: computed.projectionVersion,
          reason: "unpatchable-region-values",
          regions: regions.map((region) => region.id),
        });
      }

      return fallback;
    }

    const patch: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "projection:patch",
      sessionId: computed.session.sessionId,
      cursor: "",
      projectionVersion: computed.projectionVersion,
      patch: {
        kind: "region-values",
        regions: patchRegions,
      },
      causedByTraceId: trace?.traceId,
    };

    await persistEnvelope(computed.session, patch);

    if (trace) {
      traces.add(trace, "stream", "region patch streamed", {
        sessionId: computed.session.sessionId,
        projectionVersion: computed.projectionVersion,
        regions: regions.map((region) => region.id),
      });
    }

    return patch;
  }

  async function resolveResume(
    route: string,
    params: Record<string, string>,
    resume: { sessionId: string; cursor: string },
  ): Promise<{
    snapshot?: SessionSnapshot<TSessionState>;
    result: ResumeResult;
    replay?: ServerEnvelope<TProjection, TraceSnapshot>[];
  }> {
    const snapshot = await runStore(() => store.loadSession(resume.sessionId));

    if (!snapshot) {
      return { result: { status: "rejected", reason: "missing-session" } };
    }

    if (snapshot.route !== route || !sameParams(snapshot.params, params)) {
      return { result: { status: "rejected", reason: "route-mismatch" } };
    }

    const cursorExists = await runStore(() =>
      store.hasEnvelopeCursor(resume.sessionId, resume.cursor),
    );

    if (!cursorExists) {
      return {
        snapshot,
        result: { status: "refreshed", reason: "stale-cursor" },
      };
    }

    const replay = await runStore(() => store.readEnvelopesAfter(resume.sessionId, resume.cursor));

    if (replay.length === 0) {
      return {
        snapshot,
        result: { status: "refreshed", reason: "current-cursor" },
      };
    }

    return {
      snapshot,
      result: { status: "replayed", replayed: replay.length },
      replay: replay.map((entry) => entry.envelope),
    };
  }

  function resolveScreen(route: string) {
    return (
      program.screenByRoute.get(route) ?? (program.screens.length === 1 ? program.screens[0] : null)
    );
  }

  async function resolveRoute(route: string, params: Record<string, string>) {
    const exact = program.screenByRoute.get(route);

    if (exact) {
      const definition = screenRouteDefinition(exact);
      const matched = definition?.match(route, params);

      const resolved = {
        route: screenRoutePattern(exact),
        params: matched?.params ?? params,
      };
      await runRouteHooks(route, params, resolved.route);
      return resolved;
    }

    for (const screen of program.screens) {
      const definition = screenRouteDefinition(screen);
      const matched = definition?.match(route, params);

      if (matched) {
        await runRouteHooks(route, params, matched.route);
        return matched;
      }
    }

    await runRouteHooks(route, params, null);
    return null;
  }

  async function runRouteHooks(
    route: string,
    params: Record<string, string>,
    matchedRoute: string | null,
  ): Promise<void> {
    await program.runtime.runPromise(
      Effect.forEach(
        routePluginHooks,
        (hook) => hook.resolve?.({ route, params, matchedRoute }) ?? Effect.void,
      ),
    );
  }

  async function runSessionHooks(kind: "create" | "restore", session: Session<TSessionState>) {
    await program.runtime.runPromise(
      Effect.forEach(
        sessionPluginHooks,
        (hook) => hook[kind]?.({ session: session as Session<unknown> }) ?? Effect.void,
      ),
    );
  }

  async function runSessionUpdateHooks(
    session: Session<TSessionState>,
    message: TSessionMessage,
  ): Promise<void> {
    await program.runtime.runPromise(
      Effect.forEach(
        sessionPluginHooks,
        (hook) => hook.update?.({ session: session as Session<unknown>, message }) ?? Effect.void,
      ),
    );
  }

  async function runResourceInvalidateHooks(keys: readonly ResourceKey[]): Promise<void> {
    await program.runtime.runPromise(
      Effect.forEach(
        resourcePluginHooks,
        (hook) => hook.invalidate?.({ keys: keys.map(serializeResourceKey) }) ?? Effect.void,
      ),
    );
  }

  async function runTraceHooks(trace: TraceSnapshot): Promise<void> {
    await program.runtime.runPromise(
      Effect.forEach(trace.events, (event) =>
        Effect.forEach(tracePluginHooks, (hook) => hook.event?.({ trace, event }) ?? Effect.void),
      ),
    );
  }

  async function runStore<T>(operation: () => Promise<T>): Promise<T> {
    return program.runtime.runPromise(
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          error instanceof RuntimeStoreError
            ? error
            : runtimeStoreError(
                "read-failed",
                error instanceof Error ? error.message : "Runtime store operation failed",
                error,
              ),
      }),
    );
  }
}

function sameParams(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

function affectedRegions(
  sessions: { sessionId: string; observedRegions: ProjectionRegionSnapshot[] }[],
  keys: readonly ResourceKey[],
): AffectedRegion[] {
  const invalidated = new Set(keys.map(resourceKeyId));
  const affected: AffectedRegion[] = [];

  for (const session of sessions) {
    const regions = session.observedRegions.filter((region) =>
      region.resources.some((resource) => invalidated.has(`${resource.type}:${resource.id}`)),
    );

    if (regions.length > 0) {
      affected.push({ sessionId: session.sessionId, regions });
    }
  }

  return affected;
}

function patchableRegions(
  regions: ProjectionRegionSnapshot[],
): ProjectionPatchEnvelope["patch"]["regions"] | null {
  const patchRegions: ProjectionPatchEnvelope["patch"]["regions"] = [];

  for (const region of regions) {
    if (region.value === undefined) {
      return null;
    }

    patchRegions.push({
      id: region.id,
      value: region.value as JsonValue,
      resources: region.resources,
    });
  }

  return patchRegions;
}
