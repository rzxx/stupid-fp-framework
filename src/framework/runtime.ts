import { executeAction } from "./action";
import { Effect } from "./effect";
import {
  defaultInvocationContext,
  InvocationContext,
  type InvocationContextValue,
} from "./invocation";
import { actionHooks, resourceHooks, routeHooks, viewHooks, traceHooks } from "./plugin";
import type { SystemEvent } from "./program-input";
import type { Program } from "./program";
import { serializeResourceKey, type ResourceKey } from "./resource";
import {
  MemoryRuntimeStore,
  RuntimeStoreError,
  runtimeStoreError,
  type RuntimeStore,
} from "./store";
import { type ClientEnvelope, type ServerEnvelope } from "./stream";
import { LiveViewRegistry, type ViewContext } from "./view";
import { TraceStore, type TraceSnapshot } from "./trace";
import { runtimeResult, type RuntimeResult } from "./runtime/delivery";
import { affectedRegions, type AffectedRegion } from "./runtime/observation";
import { createProjectionService } from "./runtime/projection-service";
import { resolveResume as resolveStoredResume } from "./runtime/resume";
import { createRuntimeRouter } from "./runtime/routing";
import { persistEnvelope as persistCommittedEnvelope } from "./runtime/store-commit";
import { createRuntimeHookRunner } from "./runtime/hooks";
import { createTraceEmitter } from "./runtime/trace-emitter";
import { isNavigateInput, navigate } from "./runtime/navigation";
import { createViewRestorer } from "./runtime/view-restore";

export type { RuntimeResult } from "./runtime/delivery";

export type { AffectedRegion } from "./runtime/observation";

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
  const hookRunner = createRuntimeHookRunner<R, TUIState, TUIEvent>({
    routeHooks: routePluginHooks,
    viewHooks: viewPluginHooks,
    resourceHooks: resourcePluginHooks,
    traceHooks: tracePluginHooks,
    runEffect,
  });
  const router = createRuntimeRouter(program, (route, params, matchedRoute) =>
    hookRunner.runRouteHooks(route, params, matchedRoute, defaultInvocationContext()),
  );
  const viewRestorer = createViewRestorer({
    store,
    views,
    runStore,
    runViewHooks: hookRunner.runViewHooks,
  });
  const traceEmitter = createTraceEmitter({
    views,
    traces,
    persistEnvelope,
    runTraceHooks: hookRunner.runTraceHooks,
  });
  const projectionService = createProjectionService({
    program,
    views,
    traces,
    resolveScreen: router.resolveScreen,
    runEffect,
    persistEnvelope,
    restoreCheckpointedViews: viewRestorer.restoreCheckpointedViews,
    restoreViewForReceive: viewRestorer.restoreViewForReceive,
    findViewsObservingResources: (keys) => runStore(() => store.findViewsObservingResources(keys)),
    runResourceInvalidateHooks: hookRunner.runResourceInvalidateHooks,
    invocationForView,
  });

  return {
    traces,
    affectedRegions(keys) {
      return affectedRegions(views.list(), keys);
    },
    async invalidate(keys) {
      const invocation = resolveInvocationContext({ type: "invalidate", keys });
      return projectionService.refreshAffectedViews(keys, undefined, invocation);
    },

    async connect(envelope) {
      const invocation = resolveInvocationContext({
        type: "connect",
        route: envelope.route,
        params: envelope.params,
      });
      const resolved = await router.resolveRoute(envelope.route, envelope.params);
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
      await viewRestorer.restoreCheckpointedViews();
      const view = resume?.snapshot
        ? views.restore(resume.snapshot)
        : views.create(connectRoute.route, connectRoute.params, {
            fanoutScope: invocation.fanoutScope,
            principal: invocation.principal,
          });
      view.fanoutScope = invocation.fanoutScope;
      view.principal = invocation.principal;
      await hookRunner.runViewHooks(resume?.snapshot ? "restore" : "create", view, invocation);
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
            : [
                ...(await projectionService.project(view.viewId, undefined, invocation)).envelopes,
                ...resume.replay,
              ];

        return runtimeResult([connected, ...replay]);
      }

      const initial = await projectionService.project(view.viewId, undefined, invocation);

      return runtimeResult([connected, ...initial.envelopes]);
    },

    async receive(envelope) {
      const invocation = resolveInvocationContext({
        type: "input",
        viewId: envelope.viewId,
        clientInputId: envelope.clientInputId,
      });
      const view =
        views.get(envelope.viewId) ?? (await viewRestorer.restoreViewForReceive(envelope.viewId));

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
        return navigate({
          view,
          navigation: envelope.input,
          invocation,
          traces,
          resolveRoute: router.resolveRoute,
          scopedFanout,
          project: projectionService.project,
          traceEnvelope: traceEmitter.traceEnvelope,
        });
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
            await traceEmitter.traceEnvelope(view, trace, invocation),
          ]);
        }

        views.update(view, envelope.input as TUIEvent);
        await hookRunner.runViewUpdateHooks(view, envelope.input as TUIEvent, invocation);
        traces.add(trace, "ui", `${envelope.input.type} applied`);
        const projected = await projectionService.patchView(view.viewId, trace, invocation);
        if (trace.status !== "error") {
          traces.complete(trace);
        }

        return runtimeResult([
          ...projected.envelopes,
          await traceEmitter.traceEnvelope(view, trace, invocation),
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
          ? await projectionService.refreshAffectedViews(result.invalidated, trace, invocation)
          : { envelopes: [] };

      if (result.ok && trace.status !== "error") {
        traces.complete(trace);
      }

      return runtimeResult([
        ...(lifecycleStart ? [lifecycleStart] : []),
        actionResult,
        ...projected.envelopes,
        ...(await traceEmitter.traceEnvelopesFor(view, projected.envelopes, trace, invocation)),
      ]);
    },
  };

  async function persistEnvelope(
    view: ViewContext<TUIState>,
    envelope: ServerEnvelope<TProjection, TraceSnapshot>,
    inputRecord?: {
      clientInputId: string;
      viewId: string;
      status: "accepted" | "committed" | "failed";
    },
  ): Promise<void> {
    await persistCommittedEnvelope(
      {
        store,
        views,
        view,
        envelope,
        inputRecord,
      },
      runStore,
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
