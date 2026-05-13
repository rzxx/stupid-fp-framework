import { executeAction } from "./action";
import type { Program } from "./program";
import { resourceKeyId, serializeResourceKey, type ResourceKey } from "./resource";
import type { ProjectionRegionSnapshot } from "./projection";
import { MemoryRuntimeStore, type RuntimeStore } from "./store";
import { type ClientEnvelope, type ResumeResult, type ServerEnvelope } from "./stream";
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
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  program: Program<TServices, TSessionState, TSessionMessage, TActionMessage, TProjection>,
  options?: RuntimeOptions<TSessionState, TProjection>,
): Runtime<TSessionMessage, TActionMessage, TProjection> {
  const sessions = new SessionStore(program.session);
  const traces = new TraceStore();
  const store =
    options?.store ?? new MemoryRuntimeStore<TSessionState, TProjection, TraceSnapshot>();

  async function project(
    sessionId: string,
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const session = sessions.get(sessionId);

    if (!session) {
      return {
        envelopes: [{ type: "error", sessionId, message: "Unknown session" }],
      };
    }

    const observed = await program.resourceGraph.observe(() =>
      program.screen.project(session, {
        services: program.services,
        resources: program.resourceGraph,
        traces: traces.scoped(sessionId),
        region: (id, read) => program.resourceGraph.region(id, read),
      }),
    );

    if (trace) {
      traces.add(trace, "projection", "resources observed", {
        resources: observed.observed.map((resource) => resource.label),
      });
      traces.add(trace, "projection", "projection recomputed");
    }

    const projection = observed.value;
    const projectionVersion = sessions.bumpProjection(session);
    session.observedRegions = observed.regions;

    if (trace) {
      traces.add(trace, "stream", "projection streamed", {
        projectionVersion,
        observedResources: observed.observed.map((resource) => resource.label),
      });
    }

    const envelope: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "projection:update",
      sessionId,
      cursor: "",
      projectionVersion,
      projection,
      regions: observed.regions,
      causedByTraceId: trace?.traceId,
    };

    await persistEnvelope(session, envelope);

    return {
      envelopes: [envelope],
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
      const resume = envelope.resume
        ? await resolveResume(envelope.route, envelope.params, envelope.resume)
        : null;
      const session = resume?.snapshot
        ? sessions.restore(resume.snapshot)
        : sessions.create(envelope.route, envelope.params);
      const connected: ServerEnvelope<TProjection, TraceSnapshot> = {
        type: "connected",
        sessionId: session.sessionId,
        cursor: "",
        resumed: Boolean(resume?.snapshot),
        resume: resume?.result ?? { status: "fresh" },
      };
      await persistEnvelope(session, connected);

      if (resume?.replay) {
        return {
          envelopes: [connected, ...resume.replay],
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
        traces.add(trace, "session", `${envelope.message.type} applied`);
        const projected = await project(session.sessionId, trace);
        traces.complete(trace);

        return {
          envelopes: [...projected.envelopes, await traceEnvelope(session, trace)],
        };
      }

      const result = await executeAction(
        action,
        envelope.message as TActionMessage,
        program.services,
        traces,
        trace,
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
          ? ownSessionResult(
              await refreshAffectedSessions(result.invalidated, trace),
              session.sessionId,
            )
          : await project(session.sessionId, trace);

      if (result.ok) {
        traces.complete(trace);
      }

      return {
        envelopes: [actionResult, ...projected.envelopes, await traceEnvelope(session, trace)],
      };
    },
  };

  async function persistEnvelope(
    session: Session<TSessionState>,
    envelope: ServerEnvelope<TProjection, TraceSnapshot>,
  ): Promise<void> {
    const cursor = await store.nextCursor();

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
    await store.appendEnvelope(session.sessionId, cursor, envelope);
    await store.saveSession(sessions.snapshot(session));
  }

  async function traceEnvelope(
    session: Session<TSessionState>,
    trace: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    const envelope: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "trace:update",
      sessionId: session.sessionId,
      cursor: "",
      trace,
    };
    await persistEnvelope(session, envelope);
    return envelope;
  }

  async function refreshAffectedSessions(
    keys: readonly ResourceKey[],
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const affected = affectedRegions(sessions.list(), keys);

    program.resourceGraph.invalidate(keys);

    const envelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const affectedSession of affected) {
      if (trace) {
        traces.add(trace, "projection", "regions invalidated", {
          sessionId: affectedSession.sessionId,
          regions: affectedSession.regions.map((region) => region.id),
        });
      }

      const patch: ServerEnvelope<TProjection, TraceSnapshot> = {
        type: "projection:patch",
        sessionId: affectedSession.sessionId,
        cursor: "",
        patch: {
          kind: "regions-invalidated",
          regions: affectedSession.regions,
        },
        causedByTraceId: trace?.traceId,
      };
      const session = sessions.get(affectedSession.sessionId);

      if (!session) {
        continue;
      }

      await persistEnvelope(session, patch);
      envelopes.push(patch);
      envelopes.push(...(await project(affectedSession.sessionId, trace)).envelopes);
    }

    return { envelopes };
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
    const snapshot = await store.loadSession(resume.sessionId);

    if (!snapshot) {
      return { result: { status: "rejected", reason: "missing-session" } };
    }

    if (snapshot.route !== route || !sameParams(snapshot.params, params)) {
      return { result: { status: "rejected", reason: "route-mismatch" } };
    }

    const cursorExists = await store.hasEnvelopeCursor(resume.sessionId, resume.cursor);

    if (!cursorExists) {
      return {
        snapshot,
        result: { status: "refreshed", reason: "stale-cursor" },
      };
    }

    const replay = await store.readEnvelopesAfter(resume.sessionId, resume.cursor);

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
}

function ownSessionResult<TProjection>(
  result: RuntimeResult<TProjection>,
  sessionId: string,
): RuntimeResult<TProjection> {
  return {
    envelopes: result.envelopes.filter((envelope) => envelope.sessionId === sessionId),
  };
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
