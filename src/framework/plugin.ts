import type { Effect, Layer } from "./effect";
import type { SerializedResourceKey } from "./resource";
import type { Session } from "./session";
import type { TraceEvent, TraceSnapshot } from "./trace";

export type FrameworkPlugin<R = never> = {
  name: string;
  layer?: Layer.Layer<R>;
  hooks?: FrameworkHooks<R>;
};

export type FrameworkHooks<R> = {
  action?: ActionHooks<R>;
  resource?: ResourceHooks<R>;
  route?: RouteHooks<R>;
  session?: SessionHooks<R>;
  trace?: TraceHooks<R>;
  host?: HostHooks<R>;
  renderer?: RendererHooks<R>;
};

export type ActionHooks<R> = {
  before?: (context: ActionHookContext) => Effect.Effect<void, never, R>;
  after?: (context: ActionHookContext & { ok: boolean }) => Effect.Effect<void, never, R>;
  failure?: (context: ActionHookContext & { error: string }) => Effect.Effect<void, never, R>;
};

export type ActionHookContext = {
  actionType: string;
  message: { type: string };
  trace: TraceSnapshot;
};

export type ResourceHooks<R> = {
  beforeRead?: (context: ResourceReadHookContext) => Effect.Effect<void, never, R>;
  afterRead?: (context: ResourceReadHookContext) => Effect.Effect<void, never, R>;
  failure?: (context: ResourceReadHookContext & { error: string }) => Effect.Effect<void, never, R>;
  invalidate?: (context: ResourceInvalidateHookContext) => Effect.Effect<void, never, R>;
};

export type ResourceReadHookContext = {
  key: SerializedResourceKey;
};

export type ResourceInvalidateHookContext = {
  keys: SerializedResourceKey[];
};

export type RouteHooks<R> = {
  resolve?: (context: RouteHookContext) => Effect.Effect<void, never, R>;
};

export type RouteHookContext = {
  route: string;
  params: Record<string, string>;
  matchedRoute: string | null;
};

export type SessionHooks<R> = {
  create?: (context: SessionHookContext<unknown>) => Effect.Effect<void, never, R>;
  restore?: (context: SessionHookContext<unknown>) => Effect.Effect<void, never, R>;
  update?: (context: SessionUpdateHookContext<unknown>) => Effect.Effect<void, never, R>;
};

export type SessionHookContext<TState> = {
  session: Session<TState>;
};

export type SessionUpdateHookContext<TState> = {
  session: Session<TState>;
  message: { type: string };
};

export type TraceHooks<R> = {
  event?: (context: TraceHookContext) => Effect.Effect<void, never, R>;
};

export type TraceHookContext = {
  trace: TraceSnapshot;
  event: TraceEvent;
};

export type HostHooks<R> = {
  connect?: (context: HostHookContext) => Effect.Effect<void, never, R>;
  disconnect?: (context: HostHookContext) => Effect.Effect<void, never, R>;
  send?: (context: HostSendHookContext) => Effect.Effect<void, never, R>;
};

export type HostHookContext = {
  sessionId: string;
};

export type HostSendHookContext = {
  sessionId?: string;
  envelopeType: string;
};

export type RendererHooks<R> = {
  bootstrap?: (context: RendererHookContext) => Effect.Effect<void, never, R>;
  patch?: (context: RendererHookContext) => Effect.Effect<void, never, R>;
};

export type RendererHookContext = {
  sessionId: string;
  projectionVersion: number;
};

export function actionHooks<R>(plugins: readonly FrameworkPlugin<R>[]): ActionHooks<R>[] {
  return plugins.map((plugin) => plugin.hooks?.action).filter((hook) => hook !== undefined);
}

export function resourceHooks<R>(plugins: readonly FrameworkPlugin<R>[]): ResourceHooks<R>[] {
  return plugins.map((plugin) => plugin.hooks?.resource).filter((hook) => hook !== undefined);
}

export function routeHooks<R>(plugins: readonly FrameworkPlugin<R>[]): RouteHooks<R>[] {
  return plugins.map((plugin) => plugin.hooks?.route).filter((hook) => hook !== undefined);
}

export function sessionHooks<R>(plugins: readonly FrameworkPlugin<R>[]): SessionHooks<R>[] {
  return plugins.map((plugin) => plugin.hooks?.session).filter((hook) => hook !== undefined);
}

export function traceHooks<R>(plugins: readonly FrameworkPlugin<R>[]): TraceHooks<R>[] {
  return plugins.map((plugin) => plugin.hooks?.trace).filter((hook) => hook !== undefined);
}
