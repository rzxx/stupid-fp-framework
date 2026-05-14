import { executeAction } from "./action";
import { Effect } from "./effect";
import type { JsonValue } from "./json";
import { actionHooks, resourceHooks, routeHooks, viewHooks, traceHooks } from "./plugin";
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
import { LiveViewRegistry, type ViewCheckpoint, type ViewContext } from "./view";
import { TraceStore, type TraceSnapshot } from "./trace";

export type RuntimeResult<TProjection> = {
  envelopes: ServerEnvelope<TProjection, TraceSnapshot>[];
};

export type AffectedRegion = {
  viewId: string;
  regions: ProjectionRegionSnapshot[];
};

export type Runtime<
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
> = {
  connect: (
    envelope: Extract<ClientEnvelope<TUIEvent | TActionInput>, { type: "connect" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  receive: (
    envelope: Extract<ClientEnvelope<TUIEvent | TActionInput>, { type: "input" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  traces: TraceStore;
  affectedRegions: (keys: readonly ResourceKey[]) => AffectedRegion[];
  invalidate: (keys: readonly ResourceKey[]) => Promise<RuntimeResult<TProjection>>;
};

export type RuntimeOptions<TUIState, TProjection> = {
  store?: RuntimeStore<TUIState, TProjection, TraceSnapshot>;
};

export function createRuntime<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
>(
  program: Program<R, TUIState, TUIEvent, TActionInput, TProjection>,
  options?: RuntimeOptions<TUIState, TProjection>,
): Runtime<TUIEvent, TActionInput, TProjection> {
  const views = new LiveViewRegistry(program.uiState);
  const traces = new TraceStore();
  const actionPluginHooks = actionHooks(program.plugins);
  const resourcePluginHooks = resourceHooks(program.plugins);
  const routePluginHooks = routeHooks(program.plugins);
  const viewPluginHooks = viewHooks(program.plugins);
  const tracePluginHooks = traceHooks(program.plugins);
  const store = options?.store ?? new MemoryRuntimeStore<TUIState, TProjection, TraceSnapshot>();

  async function project(
    viewId: string,
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(viewId, trace);

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
    await persistEnvelope(computed.view, envelope);

    return {
      envelopes: [envelope],
    };
  }

  async function computeProjection(
    viewId: string,
    trace?: TraceSnapshot,
  ): Promise<
    | {
        view: ViewContext<TUIState>;
        projection: TProjection;
        projectionVersion: number;
        regions: ProjectionRegionSnapshot[];
      }
    | {
        error: ServerEnvelope<TProjection, TraceSnapshot>;
      }
  > {
    const view = views.get(viewId);

    if (!view) {
      return {
        error: { type: "error", viewId, message: "Unknown view" },
      };
    }

    const screen = resolveScreen(view.route);

    if (!screen) {
      return {
        error: {
          type: "error",
          viewId,
          message: `No screen registered for route: ${view.route}`,
        },
      };
    }

    let observed;

    try {
      observed = await program.resourceGraph.observe(() =>
        program.runtime.runPromise(
          screen.project(view, {
            resources: program.resourceGraph,
            traces: traces.scoped(viewId),
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
          viewId,
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
    const projectionVersion = views.bumpProjection(view);
    view.observedRegions = observed.regions;

    return {
      view,
      projection,
      projectionVersion,
      regions: observed.regions,
    };
  }

  function projectionEnvelope(
    computed: {
      view: ViewContext<TUIState>;
      projection: TProjection;
      projectionVersion: number;
      regions: ProjectionRegionSnapshot[];
    },
    trace?: TraceSnapshot,
  ): ServerEnvelope<TProjection, TraceSnapshot> {
    return {
      type: "projection:update",
      viewId: computed.view.viewId,
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
      return affectedRegions(views.list(), keys);
    },
    async invalidate(keys) {
      await restoreCheckpointedViews();
      return refreshAffectedViews(keys);
    },

    async connect(envelope) {
      const resolved = await resolveRoute(envelope.route, envelope.params);
      const connectRoute = resolved ?? {
        route: envelope.route,
        params: envelope.params,
      };
      await restoreCheckpointedViews();
      const resume = envelope.resume
        ? await resolveResume(connectRoute.route, connectRoute.params, envelope.resume)
        : null;
      const view = resume?.snapshot
        ? views.restore(resume.snapshot)
        : views.create(connectRoute.route, connectRoute.params);
      await runViewHooks(resume?.snapshot ? "restore" : "create", view);
      const connected: ServerEnvelope<TProjection, TraceSnapshot> = {
        type: "connected",
        viewId: view.viewId,
        cursor: "",
        resumed: Boolean(resume?.snapshot),
        resume: resume?.result ?? { status: "fresh" },
      };
      await persistEnvelope(view, connected);

      if (resume?.replay) {
        const replay =
          resume.replay[0]?.type === "projection:update"
            ? resume.replay
            : [...(await project(view.viewId)).envelopes, ...resume.replay];

        return {
          envelopes: [connected, ...replay],
        };
      }

      const initial = await project(view.viewId);

      return {
        envelopes: [connected, ...initial.envelopes],
      };
    },

    async receive(envelope) {
      const view = views.get(envelope.viewId) ?? (await restoreViewForReceive(envelope.viewId));

      if (!view) {
        return {
          envelopes: [
            {
              type: "error",
              viewId: envelope.viewId,
              message: "Unknown view",
            },
          ],
        };
      }

      const trace = traces.start(envelope.input.type, {
        scopeId: view.viewId,
      });
      traces.add(trace, "input", "input received", {
        inputType: envelope.input.type,
      });

      const action = program.actionByType.get(envelope.input.type);

      if (!action) {
        if (!program.uiState.accepts(envelope.input)) {
          traces.fail(trace, `Unknown input type: ${envelope.input.type}`);
          return {
            envelopes: [
              {
                type: "error",
                viewId: view.viewId,
                traceId: trace.traceId,
                message: `Unknown input type: ${envelope.input.type}`,
              },
              await traceEnvelope(view, trace),
            ],
          };
        }

        views.update(view, envelope.input as TUIEvent);
        await runViewUpdateHooks(view, envelope.input as TUIEvent);
        traces.add(trace, "ui", `${envelope.input.type} applied`);
        const projected = await patchView(view.viewId, trace);
        if (trace.status !== "error") {
          traces.complete(trace);
        }

        return {
          envelopes: [...projected.envelopes, await traceEnvelope(view, trace)],
        };
      }

      const result = await executeAction(
        action,
        envelope.input as TActionInput,
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
        viewId: view.viewId,
        cursor: "",
        traceId: trace.traceId,
        action: envelope.input.type.replace(/^action\./, ""),
        ok: result.ok,
        error: result.error,
        result: result.result,
      };
      await persistEnvelope(view, actionResult);
      const projected =
        result.ok && result.invalidated.length > 0
          ? await refreshAffectedViews(result.invalidated, trace)
          : { envelopes: [] };

      if (result.ok && trace.status !== "error") {
        traces.complete(trace);
      }

      return {
        envelopes: [
          actionResult,
          ...projected.envelopes,
          ...(await traceEnvelopesFor(view, projected.envelopes, trace)),
        ],
      };
    },
  };

  async function persistEnvelope(
    view: ViewContext<TUIState>,
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

    view.cursor = cursor;
    await runStore(() => store.appendEnvelope(view.viewId, cursor, envelope));
    await runStore(() => store.saveView(views.checkpoint(view)));
  }

  async function traceEnvelope(
    view: ViewContext<TUIState>,
    trace: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    await runTraceHooks(trace);
    const envelope: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "trace:update",
      viewId: view.viewId,
      cursor: "",
      trace: traces.snapshot(trace, "browser"),
    };
    await persistEnvelope(view, envelope);
    return envelope;
  }

  async function traceEnvelopesFor(
    initiatingView: ViewContext<TUIState>,
    envelopes: ServerEnvelope<TProjection, TraceSnapshot>[],
    trace: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>[]> {
    const targetViewIds = new Set([initiatingView.viewId]);

    for (const envelope of envelopes) {
      if ("viewId" in envelope && envelope.viewId) {
        targetViewIds.add(envelope.viewId);
      }
    }

    const traceEnvelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const viewId of targetViewIds) {
      const targetView = views.get(viewId);

      if (targetView) {
        traceEnvelopes.push(await traceEnvelope(targetView, trace));
      }
    }

    return traceEnvelopes;
  }

  async function patchView(
    viewId: string,
    trace: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(viewId, trace);

    if ("error" in computed) {
      return {
        envelopes: [computed.error],
      };
    }

    return {
      envelopes: [await patchEnvelope(computed, computed.regions, trace)],
    };
  }

  async function refreshAffectedViews(
    keys: readonly ResourceKey[],
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    await restoreCheckpointedViews();
    const affected = affectedRegions(views.list(), keys);

    program.resourceGraph.invalidate(keys);
    await runResourceInvalidateHooks(keys);

    const envelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const affectedView of affected) {
      const view = views.get(affectedView.viewId);

      if (!view) {
        continue;
      }

      if (trace) {
        traces.add(trace, "projection", "regions invalidated", {
          viewId: affectedView.viewId,
          regions: affectedView.regions.map((region) => region.id),
        });
      }

      const computed = await computeProjection(affectedView.viewId, trace);

      if ("error" in computed) {
        envelopes.push(computed.error);
        continue;
      }

      const invalidatedRegionIds = new Set(affectedView.regions.map((region) => region.id));
      const regions = computed.regions.filter((region) => invalidatedRegionIds.has(region.id));
      const patchOrProjection = await patchEnvelope(computed, regions, trace);
      envelopes.push(patchOrProjection);
    }

    return { envelopes };
  }

  async function patchEnvelope(
    computed: {
      view: ViewContext<TUIState>;
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
      await persistEnvelope(computed.view, fallback);

      if (trace) {
        traces.add(trace, "stream", "projection fallback streamed", {
          viewId: computed.view.viewId,
          projectionVersion: computed.projectionVersion,
          reason: "unpatchable-region-values",
          regions: regions.map((region) => region.id),
        });
      }

      return fallback;
    }

    const patch: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "projection:patch",
      viewId: computed.view.viewId,
      cursor: "",
      projectionVersion: computed.projectionVersion,
      patch: {
        kind: "region-values",
        regions: patchRegions,
      },
      causedByTraceId: trace?.traceId,
    };

    await persistEnvelope(computed.view, patch);

    if (trace) {
      traces.add(trace, "stream", "region patch streamed", {
        viewId: computed.view.viewId,
        projectionVersion: computed.projectionVersion,
        regions: regions.map((region) => region.id),
      });
    }

    return patch;
  }

  async function resolveResume(
    route: string,
    params: Record<string, string>,
    resume: { viewId: string; cursor: string },
  ): Promise<{
    snapshot?: ViewCheckpoint<TUIState>;
    result: ResumeResult;
    replay?: ServerEnvelope<TProjection, TraceSnapshot>[];
  }> {
    const snapshot = await runStore(() => store.loadView(resume.viewId));

    if (!snapshot) {
      return { result: { status: "rejected", reason: "missing-view" } };
    }

    if (snapshot.route !== route || !sameParams(snapshot.params, params)) {
      return { result: { status: "rejected", reason: "route-mismatch" } };
    }

    const cursorExists = await runStore(() =>
      store.hasEnvelopeCursor(resume.viewId, resume.cursor),
    );

    if (!cursorExists) {
      return {
        snapshot,
        result: { status: "refreshed", reason: "stale-cursor" },
      };
    }

    const replay = await runStore(() => store.readEnvelopesAfter(resume.viewId, resume.cursor));

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

  async function restoreViewForReceive(viewId: string): Promise<ViewContext<TUIState> | undefined> {
    const snapshot = await runStore(() => store.loadView(viewId));

    if (!snapshot) {
      return undefined;
    }

    const view = views.restore(snapshot);
    await runViewHooks("restore", view);
    return view;
  }

  async function restoreCheckpointedViews(): Promise<void> {
    const snapshots = await runStore(() => store.listViews());

    for (const snapshot of snapshots) {
      if (!views.get(snapshot.viewId)) {
        views.restore(snapshot);
      }
    }
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

  async function runViewHooks(kind: "create" | "restore", view: ViewContext<TUIState>) {
    await program.runtime.runPromise(
      Effect.forEach(
        viewPluginHooks,
        (hook) => hook[kind]?.({ view: view as ViewContext<unknown> }) ?? Effect.void,
      ),
    );
  }

  async function runViewUpdateHooks(view: ViewContext<TUIState>, input: TUIEvent): Promise<void> {
    await program.runtime.runPromise(
      Effect.forEach(
        viewPluginHooks,
        (hook) => hook.update?.({ view: view as ViewContext<unknown>, input }) ?? Effect.void,
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
  views: { viewId: string; observedRegions: ProjectionRegionSnapshot[] }[],
  keys: readonly ResourceKey[],
): AffectedRegion[] {
  const invalidated = new Set(keys.map(resourceKeyId));
  const affected: AffectedRegion[] = [];

  for (const view of views) {
    const regions = view.observedRegions.filter((region) =>
      region.resources.some((resource) => invalidated.has(`${resource.type}:${resource.id}`)),
    );

    if (regions.length > 0) {
      affected.push({ viewId: view.viewId, regions });
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
