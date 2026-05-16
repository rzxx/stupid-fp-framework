import { executeAction } from "./action";
import { Effect } from "./effect";
import {
  defaultInvocationContext,
  InvocationContext,
  type InvocationContextValue,
} from "./invocation";
import { actionHooks, resourceHooks, routeHooks, viewHooks, traceHooks } from "./plugin";
import type { SystemEvent } from "./program-input";
import { screenRouteDefinition, screenRoutePattern, type Program } from "./program";
import { serializeResourceKey, type ResourceKey } from "./resource";
import type { ProjectionRegionSnapshot } from "./projection";
import {
  MemoryRuntimeStore,
  RuntimeStoreError,
  runtimeStoreError,
  type RuntimeStore,
} from "./store";
import { type ClientEnvelope, type ServerEnvelope } from "./stream";
import { LiveViewRegistry, type ViewContext } from "./view";
import { TraceStore, type TraceSnapshot } from "./trace";
import { runtimeResult, type RuntimeResult } from "./runtime-delivery";
import { affectedRegions, type AffectedRegion } from "./runtime-observation";
import { patchableRegions } from "./runtime-patch";
import { resolveResume as resolveStoredResume } from "./runtime-resume";

export type { RuntimeResult } from "./runtime-delivery";

export type { AffectedRegion } from "./runtime-observation";

export type Runtime<
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
> = {
  connect: (
    envelope: Extract<ClientEnvelope<TUIEvent | TActionInput | SystemEvent>, { type: "connect" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  receive: (
    envelope: Extract<ClientEnvelope<TUIEvent | TActionInput | SystemEvent>, { type: "input" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  traces: TraceStore;
  affectedRegions: (keys: readonly ResourceKey[]) => AffectedRegion[];
  invalidate: (keys: readonly ResourceKey[]) => Promise<RuntimeResult<TProjection>>;
};

export type RuntimeOptions<TUIState, TProjection> = {
  store?: RuntimeStore<TUIState, TProjection, TraceSnapshot>;
  traces?: TraceStore;
  fanoutScope?: (route: string, params: Record<string, string>) => string;
  invocationContext?: (
    input:
      | { type: "connect"; route: string; params: Record<string, string> }
      | { type: "input"; viewId: string; clientInputId?: string }
      | { type: "invalidate"; keys: readonly ResourceKey[] },
  ) => Partial<InvocationContextValue>;
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
  const traces = options?.traces ?? new TraceStore();
  const actionPluginHooks = actionHooks(program.plugins);
  const resourcePluginHooks = resourceHooks(program.plugins);
  const routePluginHooks = routeHooks(program.plugins);
  const viewPluginHooks = viewHooks(program.plugins);
  const tracePluginHooks = traceHooks(program.plugins);
  const store = options?.store ?? new MemoryRuntimeStore<TUIState, TProjection, TraceSnapshot>();

  async function project(
    viewId: string,
    trace?: TraceSnapshot,
    invocation = defaultInvocationContext(),
  ): Promise<RuntimeResult<TProjection>> {
    const computed = await computeProjection(viewId, trace, invocation);

    if ("error" in computed) {
      return {
        ...runtimeResult([computed.error]),
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
      ...runtimeResult([envelope]),
    };
  }

  async function computeProjection(
    viewId: string,
    trace?: TraceSnapshot,
    invocation = defaultInvocationContext(),
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
      observed = await program.resourceGraph.observe(() => {
        const traceReader = traces.scoped(viewId);

        if (screen.projectAsync) {
          return screen.projectAsync(view, {
            traces: traceReader,
            read: (key) => runEffect(program.resourceGraph.read(key), invocation),
            region: (id, read) => program.resourceGraph.regionAsync(id, read),
          });
        }

        if (!screen.project) {
          throw new Error(`No projection registered for route: ${view.route}`);
        }

        return runEffect(
          screen.project(view, {
            resources: program.resourceGraph,
            traces: traceReader,
            read: (key) => program.resourceGraph.read(key),
            region: (id, read) => program.resourceGraph.region(id, read),
          }),
          invocation,
        );
      });
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
      projectionManifestVersion: resolveScreen(computed.view.route)?.patchManifest
        ?.projectionVersion,
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
      const invocation = resolveInvocationContext({ type: "invalidate", keys });
      return refreshAffectedViews(keys, undefined, invocation);
    },

    async connect(envelope) {
      const invocation = resolveInvocationContext({
        type: "connect",
        route: envelope.route,
        params: envelope.params,
      });
      const resolved = await resolveRoute(envelope.route, envelope.params);
      const connectRoute = resolved ?? {
        route: envelope.route,
        params: envelope.params,
      };
      invocation.fanoutScope = scopedFanout(connectRoute.route, connectRoute.params, invocation);
      const resume = envelope.resume
        ? await resolveStoredResume(
            { route: connectRoute.route, params: connectRoute.params, resume: envelope.resume },
            store,
            runStore,
          )
        : null;
      await restoreCheckpointedViews();
      const view = resume?.snapshot
        ? views.restore(resume.snapshot)
        : views.create(connectRoute.route, connectRoute.params, {
            fanoutScope: invocation.fanoutScope,
            principal: invocation.principal,
          });
      view.fanoutScope = invocation.fanoutScope;
      view.principal = invocation.principal;
      await runViewHooks(resume?.snapshot ? "restore" : "create", view, invocation);
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
            : [...(await project(view.viewId, undefined, invocation)).envelopes, ...resume.replay];

        return runtimeResult([connected, ...replay]);
      }

      const initial = await project(view.viewId, undefined, invocation);

      return runtimeResult([connected, ...initial.envelopes]);
    },

    async receive(envelope) {
      const invocation = resolveInvocationContext({
        type: "input",
        viewId: envelope.viewId,
        clientInputId: envelope.clientInputId,
      });
      const view = views.get(envelope.viewId) ?? (await restoreViewForReceive(envelope.viewId));

      if (!view) {
        return runtimeResult([
          {
            type: "error",
            viewId: envelope.viewId,
            message: "Unknown view",
          },
        ]);
      }

      invocation.fanoutScope = view.fanoutScope;
      invocation.principal = invocation.principal ?? view.principal;
      invocation.clientInputId = envelope.clientInputId;
      view.principal = invocation.principal;

      if (isNavigateInput(envelope.input)) {
        return navigate(view, envelope.input, invocation);
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
          return runtimeResult([
            {
              type: "error",
              viewId: view.viewId,
              traceId: trace.traceId,
              message: `Unknown input type: ${envelope.input.type}`,
            },
            await traceEnvelope(view, trace, invocation),
          ]);
        }

        views.update(view, envelope.input as TUIEvent);
        await runViewUpdateHooks(view, envelope.input as TUIEvent, invocation);
        traces.add(trace, "ui", `${envelope.input.type} applied`);
        const projected = await patchView(view.viewId, trace, invocation);
        if (trace.status !== "error") {
          traces.complete(trace);
        }

        return runtimeResult([
          ...projected.envelopes,
          await traceEnvelope(view, trace, invocation),
        ]);
      }

      const actionName = envelope.input.type.replace(/^action\./, "");
      const lifecycleStart: ServerEnvelope<TProjection, TraceSnapshot> | null =
        envelope.clientInputId
          ? {
              type: "action:lifecycle",
              viewId: view.viewId,
              cursor: "",
              traceId: trace.traceId,
              clientInputId: envelope.clientInputId,
              action: actionName,
              stage: "started",
            }
          : null;

      if (lifecycleStart) {
        await persistEnvelope(view, lifecycleStart, {
          clientInputId: lifecycleStart.clientInputId as string,
          viewId: view.viewId,
          status: "accepted",
        });
      }

      const result = await executeAction(
        action,
        envelope.input as TActionInput,
        program.runtime,
        traces,
        trace,
        actionPluginHooks,
        (effect) => runEffect(effect, invocation),
      );

      traces.add(trace, "resource", "resources invalidated", {
        resources: result.invalidated.map((key) => serializeResourceKey(key).label),
      });
      const actionResult: ServerEnvelope<TProjection, TraceSnapshot> = {
        type: "action:result",
        viewId: view.viewId,
        cursor: "",
        traceId: trace.traceId,
        clientInputId: envelope.clientInputId,
        action: actionName,
        ok: result.ok,
        error: result.error,
        result: result.result,
      };
      await persistEnvelope(
        view,
        actionResult,
        envelope.clientInputId
          ? {
              clientInputId: envelope.clientInputId,
              viewId: view.viewId,
              status: result.ok ? "committed" : "failed",
            }
          : undefined,
      );
      const projected =
        result.ok && result.invalidated.length > 0
          ? await refreshAffectedViews(result.invalidated, trace, invocation)
          : { envelopes: [] };

      if (result.ok && trace.status !== "error") {
        traces.complete(trace);
      }

      return runtimeResult([
        ...(lifecycleStart ? [lifecycleStart] : []),
        actionResult,
        ...projected.envelopes,
        ...(await traceEnvelopesFor(view, projected.envelopes, trace, invocation)),
      ]);
    },
  };

  async function navigate(
    view: ViewContext<TUIState>,
    input: {
      type: "system.navigate";
      path: string;
      params?: Record<string, string>;
      navigation?: "push" | "replace" | "pop" | "hash";
    },
    invocation: InvocationContextValue,
  ): Promise<RuntimeResult<TProjection>> {
    const trace = traces.start(input.type, {
      scopeId: view.viewId,
    });
    const resolved = await resolveRoute(input.path, input.params ?? {});

    if (!resolved) {
      traces.fail(trace, `No screen registered for route: ${input.path}`);
      return runtimeResult([
        {
          type: "error",
          viewId: view.viewId,
          traceId: trace.traceId,
          message: `No screen registered for route: ${input.path}`,
        },
        await traceEnvelope(view, trace, invocation),
      ]);
    }

    traces.add(trace, "system", "navigation resolved", {
      path: input.path,
      route: resolved.route,
      navigation: input.navigation ?? "push",
    });
    view.route = resolved.route;
    view.params = resolved.params;
    view.fanoutScope = scopedFanout(view.route, view.params, invocation);
    invocation.fanoutScope = view.fanoutScope;
    view.principal = invocation.principal;

    const projected = await project(view.viewId, trace, invocation);

    if (trace.status !== "error") {
      traces.complete(trace);
    }

    return runtimeResult([...projected.envelopes, await traceEnvelope(view, trace, invocation)]);
  }

  async function persistEnvelope(
    view: ViewContext<TUIState>,
    envelope: ServerEnvelope<TProjection, TraceSnapshot>,
    inputRecord?: {
      clientInputId: string;
      viewId: string;
      status: "accepted" | "committed" | "failed";
    },
  ): Promise<void> {
    const committed = await runStore(() =>
      store.commitInvocation({
        envelopes: [{ viewId: view.viewId, envelope }],
        views: [
          {
            checkpoint: views.checkpoint(view),
            expectedRevision: view.checkpointRevision,
          },
        ],
        observations: [
          {
            fanoutScope: view.fanoutScope,
            viewId: view.viewId,
            regions: view.observedRegions,
          },
        ],
        inputRecords: inputRecord ? [inputRecord] : [],
      }),
    );
    const committedEnvelope = committed.envelopes[0]?.envelope;
    const committedView = committed.views[0];

    if (committedEnvelope) {
      Object.assign(envelope, committedEnvelope);
    }

    if (committedView) {
      view.cursor = committedView.cursor;
      view.checkpointRevision = committedView.checkpointRevision ?? view.checkpointRevision;
      view.fanoutScope = committedView.fanoutScope ?? view.fanoutScope;
    }
  }

  async function traceEnvelope(
    view: ViewContext<TUIState>,
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    await runTraceHooks(trace, invocation);
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
    invocation: InvocationContextValue,
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
        traceEnvelopes.push(await traceEnvelope(targetView, trace, invocation));
      }
    }

    return traceEnvelopes;
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
    trace?: TraceSnapshot,
    invocation = defaultInvocationContext(),
  ): Promise<RuntimeResult<TProjection>> {
    const serializedKeys = keys.map(serializeResourceKey);
    const indexedAffected = await runStore(() => store.findViewsObservingResources(serializedKeys));
    const affected =
      indexedAffected.length > 0
        ? indexedAffected
        : affectedRegions(await restoreCheckpointedViews(), keys);

    program.resourceGraph.invalidate(keys);
    await runResourceInvalidateHooks(keys, invocation);

    const envelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const affectedView of affected) {
      const view =
        views.get(affectedView.viewId) ?? (await restoreViewForReceive(affectedView.viewId));

      if (!view) {
        continue;
      }

      if (trace) {
        traces.add(trace, "projection", "regions invalidated", {
          viewId: affectedView.viewId,
          regions: affectedView.regions.map((region) => region.id),
        });
      }

      const computed = await computeProjection(
        affectedView.viewId,
        trace,
        invocationForView(view, invocation),
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
      projectionManifestVersion: resolveScreen(computed.view.route)?.patchManifest
        ?.projectionVersion,
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

  async function restoreViewForReceive(viewId: string): Promise<ViewContext<TUIState> | undefined> {
    const snapshot = await runStore(() => store.loadView(viewId));

    if (!snapshot) {
      return undefined;
    }

    const view = views.restore(snapshot);
    await runViewHooks(
      "restore",
      view,
      defaultInvocationContext({ fanoutScope: view.fanoutScope, principal: view.principal }),
    );
    return view;
  }

  async function restoreCheckpointedViews(): Promise<ViewContext<TUIState>[]> {
    const snapshots = await runStore(() => store.listViews());

    for (const snapshot of snapshots) {
      if (!views.get(snapshot.viewId)) {
        views.restore(snapshot);
      }
    }

    return views.list();
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
    await runEffect(
      Effect.forEach(
        routePluginHooks,
        (hook) => hook.resolve?.({ route, params, matchedRoute }) ?? Effect.void,
      ),
      defaultInvocationContext(),
    );
  }

  async function runViewHooks(
    kind: "create" | "restore",
    view: ViewContext<TUIState>,
    invocation: InvocationContextValue,
  ) {
    await runEffect(
      Effect.forEach(
        viewPluginHooks,
        (hook) => hook[kind]?.({ view: view as ViewContext<unknown> }) ?? Effect.void,
      ),
      invocation,
    );
  }

  async function runViewUpdateHooks(
    view: ViewContext<TUIState>,
    input: TUIEvent,
    invocation: InvocationContextValue,
  ): Promise<void> {
    await runEffect(
      Effect.forEach(
        viewPluginHooks,
        (hook) => hook.update?.({ view: view as ViewContext<unknown>, input }) ?? Effect.void,
      ),
      invocation,
    );
  }

  async function runResourceInvalidateHooks(
    keys: readonly ResourceKey[],
    invocation: InvocationContextValue,
  ): Promise<void> {
    await runEffect(
      Effect.forEach(
        resourcePluginHooks,
        (hook) => hook.invalidate?.({ keys: keys.map(serializeResourceKey) }) ?? Effect.void,
      ),
      invocation,
    );
  }

  async function runTraceHooks(
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ): Promise<void> {
    await runEffect(
      Effect.forEach(trace.events, (event) =>
        Effect.forEach(tracePluginHooks, (hook) => hook.event?.({ trace, event }) ?? Effect.void),
      ),
      invocation,
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

  function resolveInvocationContext(
    input:
      | { type: "connect"; route: string; params: Record<string, string> }
      | { type: "input"; viewId: string; clientInputId?: string }
      | { type: "invalidate"; keys: readonly ResourceKey[] },
  ): InvocationContextValue {
    const resolved = options?.invocationContext?.(input);

    return defaultInvocationContext(resolved);
  }

  function scopedFanout(
    route: string,
    params: Record<string, string>,
    invocation: InvocationContextValue,
  ): string {
    return options?.fanoutScope?.(route, params) ?? invocation.fanoutScope;
  }

  function runEffect<A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
    invocation: InvocationContextValue,
  ): Promise<A> {
    return program.runtime.runPromise(
      Effect.provideService(
        effect as Effect.Effect<A, E, R | InvocationContext>,
        InvocationContext,
        invocation,
      ),
    );
  }

  function invocationForView(
    view: ViewContext<TUIState>,
    invocation: InvocationContextValue,
  ): InvocationContextValue {
    return {
      ...invocation,
      fanoutScope: view.fanoutScope,
      principal: view.principal ?? invocation.principal,
    };
  }
}

function isNavigateInput(value: unknown): value is {
  type: "system.navigate";
  path: string;
  params?: Record<string, string>;
  navigation?: "push" | "replace" | "pop" | "hash";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return input.type === "system.navigate" && typeof input.path === "string";
}
