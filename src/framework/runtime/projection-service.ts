import { Effect } from "../effect";
import type { InvocationContextValue } from "../invocation";
import type { Program } from "../program";
import type { ProjectionRegionSnapshot } from "../projection";
import { serializeResourceKey, type ResourceKey } from "../resource";
import type { RuntimeStore } from "../store";
import type { ServerEnvelope } from "../stream";
import type { TraceSnapshot, TraceStore } from "../trace";
import type { LiveViewRegistry, ViewContext } from "../view";
import { runtimeResult, type RuntimeResult } from "./delivery";
import { affectedRegions } from "./observation";
import { patchableRegions } from "./patch";

type ComputedProjection<TUIState, TProjection> = {
  view: ViewContext<TUIState>;
  projection: TProjection;
  projectionVersion: number;
  regions: ProjectionRegionSnapshot[];
};

export function createProjectionService<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
>(deps: {
  program: Program<R, TUIState, TUIEvent, TActionInput, TProjection>;
  views: LiveViewRegistry<TUIState, TUIEvent>;
  traces: TraceStore;
  resolveScreen: (
    route: string,
  ) => Program<R, TUIState, TUIEvent, TActionInput, TProjection>["screens"][number] | null;
  runEffect: <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
    invocation: InvocationContextValue,
  ) => Promise<A>;
  persistEnvelope: (
    view: ViewContext<TUIState>,
    envelope: ServerEnvelope<TProjection, TraceSnapshot>,
    inputRecord?: {
      clientInputId: string;
      viewId: string;
      status: "accepted" | "committed" | "failed";
    },
  ) => Promise<void>;
  restoreCheckpointedViews: () => Promise<ViewContext<TUIState>[]>;
  restoreViewForReceive: (viewId: string) => Promise<ViewContext<TUIState> | undefined>;
  findViewsObservingResources: RuntimeStore<
    TUIState,
    TProjection,
    TraceSnapshot
  >["findViewsObservingResources"];
  runResourceInvalidateHooks: (
    keys: readonly ResourceKey[],
    invocation: InvocationContextValue,
  ) => Promise<void>;
  invocationForView: (
    view: ViewContext<TUIState>,
    invocation: InvocationContextValue,
  ) => InvocationContextValue;
}) {
  async function project(
    viewId: string,
    trace: TraceSnapshot | undefined,
    invocation: InvocationContextValue,
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(viewId, trace, invocation);

    if ("error" in computed) {
      return {
        ...runtimeResult([computed.error]),
      };
    }

    const envelope = projectionEnvelope(computed, trace);
    if (trace) {
      deps.traces.add(trace, "stream", "projection streamed", {
        projectionVersion: computed.projectionVersion,
        observedResources: computed.regions.flatMap((region) =>
          region.resources.map((resource) => resource.label),
        ),
      });
    }
    await deps.persistEnvelope(computed.view, envelope);

    return {
      ...runtimeResult([envelope]),
    };
  }

  async function patchView(
    viewId: string,
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(viewId, trace, invocation);

    if ("error" in computed) {
      return {
        ...runtimeResult([computed.error]),
      };
    }

    return runtimeResult([await patchEnvelope(computed, computed.regions, trace)]);
  }

  async function refreshAffectedViews(
    keys: readonly ResourceKey[],
    trace: TraceSnapshot | undefined,
    invocation: InvocationContextValue,
  ): Promise<RuntimeResult<TProjection>> {
    const serializedKeys = keys.map(serializeResourceKey);
    const indexedAffected = await deps.findViewsObservingResources(serializedKeys);
    const affected =
      indexedAffected.length > 0
        ? indexedAffected
        : affectedRegions(await deps.restoreCheckpointedViews(), keys);

    deps.program.resourceGraph.invalidate(keys);
    await deps.runResourceInvalidateHooks(keys, invocation);

    const envelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const affectedView of affected) {
      const view =
        deps.views.get(affectedView.viewId) ??
        (await deps.restoreViewForReceive(affectedView.viewId));

      if (!view) {
        continue;
      }

      if (trace) {
        deps.traces.add(trace, "projection", "regions invalidated", {
          viewId: affectedView.viewId,
          regions: affectedView.regions.map((region) => region.id),
        });
      }

      const computed = await computeProjection(
        affectedView.viewId,
        trace,
        deps.invocationForView(view, invocation),
      );

      if ("error" in computed) {
        envelopes.push(computed.error);
        continue;
      }

      const invalidatedRegionIds = new Set(affectedView.regions.map((region) => region.id));
      const regions = computed.regions.filter((region) => invalidatedRegionIds.has(region.id));
      const patchOrProjection = await patchEnvelope(computed, regions, trace);
      envelopes.push(patchOrProjection);
    }

    return runtimeResult(envelopes);
  }

  async function computeProjection(
    viewId: string,
    trace: TraceSnapshot | undefined,
    invocation: InvocationContextValue,
  ): Promise<
    | ComputedProjection<TUIState, TProjection>
    | {
        error: ServerEnvelope<TProjection, TraceSnapshot>;
      }
  > {
    const view = deps.views.get(viewId);

    if (!view) {
      return {
        error: { type: "error", viewId, message: "Unknown view" },
      };
    }

    const screen = deps.resolveScreen(view.route);

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
      observed = await deps.program.resourceGraph.observe(() => {
        const traceReader = deps.traces.scoped(viewId);

        if (screen.projectAsync) {
          return screen.projectAsync(view, {
            traces: traceReader,
            read: (key) => deps.runEffect(deps.program.resourceGraph.read(key), invocation),
            region: (id, read) => deps.program.resourceGraph.regionAsync(id, read),
          });
        }

        if (!screen.project) {
          throw new Error(`No projection registered for route: ${view.route}`);
        }

        return deps.runEffect(
          screen.project(view, {
            resources: deps.program.resourceGraph,
            traces: traceReader,
            read: (key) => deps.program.resourceGraph.read(key),
            region: (id, read) => deps.program.resourceGraph.region(id, read),
          }),
          invocation,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Projection failed";

      if (trace) {
        deps.traces.fail(trace, message);
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
      deps.traces.add(trace, "projection", "resources observed", {
        resources: observed.observed.map((resource) => resource.label),
      });
      deps.traces.add(trace, "projection", "projection recomputed");
    }

    const projection = observed.value;
    const projectionVersion = deps.views.bumpProjection(view);
    view.observedRegions = observed.regions;

    return {
      view,
      projection,
      projectionVersion,
      regions: observed.regions,
    };
  }

  function projectionEnvelope(
    computed: ComputedProjection<TUIState, TProjection>,
    trace?: TraceSnapshot,
  ): ServerEnvelope<TProjection, TraceSnapshot> {
    return {
      type: "projection:update",
      viewId: computed.view.viewId,
      cursor: "",
      projectionVersion: computed.projectionVersion,
      projectionManifestVersion: deps.resolveScreen(computed.view.route)?.patchManifest
        ?.projectionVersion,
      projection: computed.projection,
      regions: computed.regions,
      causedByTraceId: trace?.traceId,
    };
  }

  async function patchEnvelope(
    computed: ComputedProjection<TUIState, TProjection>,
    regions: ProjectionRegionSnapshot[],
    trace?: TraceSnapshot,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    const patchRegions = patchableRegions(regions);

    if (!patchRegions) {
      const fallback = projectionEnvelope(computed, trace);
      await deps.persistEnvelope(computed.view, fallback);

      if (trace) {
        deps.traces.add(trace, "stream", "projection fallback streamed", {
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
      projectionManifestVersion: deps.resolveScreen(computed.view.route)?.patchManifest
        ?.projectionVersion,
      patch: {
        kind: "region-values",
        regions: patchRegions,
      },
      causedByTraceId: trace?.traceId,
    };

    await deps.persistEnvelope(computed.view, patch);

    if (trace) {
      deps.traces.add(trace, "stream", "region patch streamed", {
        viewId: computed.view.viewId,
        projectionVersion: computed.projectionVersion,
        regions: regions.map((region) => region.id),
      });
    }

    return patch;
  }

  return {
    project,
    patchView,
    refreshAffectedViews,
  };
}
