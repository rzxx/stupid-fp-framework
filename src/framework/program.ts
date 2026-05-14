import type { ActionDefinition } from "./action";
import { Layer, ManagedRuntime } from "./effect";
import type { JsonValue } from "./json";
import { resourceHooks, type FrameworkPlugin } from "./plugin";
import { ResourceGraph, type ResourceDefinition } from "./resource";
import type { ScreenDefinition } from "./projection";
import type { RouteDefinition } from "./route";
import type { SessionDefinition, SessionRuntimeDefinition } from "./session";
import type { UIStateDefinition } from "./ui-state";

export type ProgramDefinition<
  R,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = {
  layer?: Layer.Layer<R>;
  plugins?: FrameworkPlugin<R>[];
  resources: ResourceDefinition<R, unknown>[];
  session?: SessionDefinition<TSessionState, TSessionMessage>;
  uiState?: UIStateDefinition<TSessionState, TSessionMessage>;
  screen?: ScreenDefinition<R, TSessionState, TProjection>;
  screens?: ScreenDefinition<R, TSessionState, TProjection>[];
  actions: ActionDefinition<R, TActionMessage, JsonValue | void>[];
};

export type Program<
  R,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = ProgramDefinition<R, TSessionState, TSessionMessage, TActionMessage, TProjection> & {
  layer: Layer.Layer<R>;
  runtime: ManagedRuntime.ManagedRuntime<R, never>;
  plugins: FrameworkPlugin<R>[];
  resourceGraph: ResourceGraph<R>;
  session: SessionRuntimeDefinition<TSessionState, TSessionMessage>;
  actionByType: Map<string, ActionDefinition<R, TActionMessage, JsonValue | void>>;
  screens: ScreenDefinition<R, TSessionState, TProjection>[];
  screenByRoute: Map<string, ScreenDefinition<R, TSessionState, TProjection>>;
  routes: RouteDefinition[];
};

export function defineProgram<
  R,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  definition: ProgramDefinition<R, TSessionState, TSessionMessage, TActionMessage, TProjection>,
): Program<R, TSessionState, TSessionMessage, TActionMessage, TProjection> {
  const plugins = definition.plugins ?? [];
  const resourceGraph = new ResourceGraph<R>(resourceHooks(plugins));
  const screens = normalizeScreens(definition);
  const baseLayer = definition.layer ?? (Layer.empty as Layer.Layer<R>);
  const layer =
    plugins.length === 0
      ? baseLayer
      : (Layer.mergeAll(
          baseLayer,
          ...plugins.map((plugin) => plugin.layer).filter((layer) => layer !== undefined),
        ) as Layer.Layer<R>);

  for (const resource of definition.resources) {
    resourceGraph.register(resource);
  }

  return {
    ...definition,
    layer,
    plugins,
    runtime: ManagedRuntime.make(layer),
    session: definition.uiState ?? requireSession(definition.session),
    screens,
    screenByRoute: new Map(screens.map((screen) => [screenRoutePattern(screen), screen])),
    routes: screens.map(screenRouteDefinition).filter((route) => route !== null),
    resourceGraph,
    actionByType: new Map(definition.actions.map((action) => [String(action.type), action])),
  };
}

function requireSession<TSessionState, TSessionMessage extends { type: string }>(
  session: SessionDefinition<TSessionState, TSessionMessage> | undefined,
): SessionDefinition<TSessionState, TSessionMessage> {
  if (!session) {
    throw new Error("Program must define uiState or session");
  }

  return session;
}

export function screenRoutePattern<R, TSessionState, TProjection>(
  screen: ScreenDefinition<R, TSessionState, TProjection>,
): string {
  return typeof screen.route === "string" ? screen.route : screen.route.pattern;
}

export function screenRouteDefinition<R, TSessionState, TProjection>(
  screen: ScreenDefinition<R, TSessionState, TProjection>,
): RouteDefinition | null {
  return typeof screen.route === "string" ? null : screen.route;
}

function normalizeScreens<
  R,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  definition: ProgramDefinition<R, TSessionState, TSessionMessage, TActionMessage, TProjection>,
): ScreenDefinition<R, TSessionState, TProjection>[] {
  const screens = definition.screens ?? (definition.screen ? [definition.screen] : []);

  if (screens.length === 0) {
    throw new Error("Program must define at least one screen");
  }

  return screens;
}
