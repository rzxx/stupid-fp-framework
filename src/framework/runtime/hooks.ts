import { Effect } from "../effect";
import type { ResourceHooks, RouteHooks, TraceHooks, ViewHooks } from "../plugin";
import { serializeResourceKey, type ResourceKey } from "../resource";
import type { TraceSnapshot } from "../trace";
import type { InvocationContextValue } from "../invocation";
import type { ViewContext } from "../view";

export function createRuntimeHookRunner<R, TUIState, TUIEvent extends { type: string }>(deps: {
  routeHooks: RouteHooks<R>[];
  viewHooks: ViewHooks<R>[];
  resourceHooks: ResourceHooks<R>[];
  traceHooks: TraceHooks<R>[];
  runEffect: <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
    invocation: InvocationContextValue,
  ) => Promise<A>;
}) {
  async function runRouteHooks(
    route: string,
    params: Record<string, string>,
    matchedRoute: string | null,
    invocation: InvocationContextValue,
  ): Promise<void> {
    await deps.runEffect(
      Effect.forEach(
        deps.routeHooks,
        (hook) => hook.resolve?.({ route, params, matchedRoute }) ?? Effect.void,
      ),
      invocation,
    );
  }

  async function runViewHooks(
    kind: "create" | "restore",
    view: ViewContext<TUIState>,
    invocation: InvocationContextValue,
  ) {
    await deps.runEffect(
      Effect.forEach(
        deps.viewHooks,
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
    await deps.runEffect(
      Effect.forEach(
        deps.viewHooks,
        (hook) => hook.update?.({ view: view as ViewContext<unknown>, input }) ?? Effect.void,
      ),
      invocation,
    );
  }

  async function runResourceInvalidateHooks(
    keys: readonly ResourceKey[],
    invocation: InvocationContextValue,
  ): Promise<void> {
    await deps.runEffect(
      Effect.forEach(
        deps.resourceHooks,
        (hook) => hook.invalidate?.({ keys: keys.map(serializeResourceKey) }) ?? Effect.void,
      ),
      invocation,
    );
  }

  async function runTraceHooks(
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ): Promise<void> {
    await deps.runEffect(
      Effect.forEach(trace.events, (event) =>
        Effect.forEach(deps.traceHooks, (hook) => hook.event?.({ trace, event }) ?? Effect.void),
      ),
      invocation,
    );
  }

  return {
    runRouteHooks,
    runViewHooks,
    runViewUpdateHooks,
    runResourceInvalidateHooks,
    runTraceHooks,
  };
}
