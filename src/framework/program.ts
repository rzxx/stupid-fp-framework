import type { ActionDefinition } from "./action";
import { Layer, ManagedRuntime } from "./effect";
import type { JsonValue } from "./json";
import { resourceHooks, type FrameworkPlugin } from "./plugin";
import { ResourceGraph, type ResourceDefinition } from "./resource";
import type { ScreenDefinition } from "./projection";
import type { RouteDefinition } from "./route";
import type { UIStateDefinition } from "./ui-state";

export type ProgramDefinition<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
> = {
  layer?: Layer.Layer<R>;
  plugins?: FrameworkPlugin<R>[];
  resources: ResourceDefinition<R, unknown>[];
  uiState: UIStateDefinition<TUIState, TUIEvent>;
  screen?: ScreenDefinition<R, TUIState, TProjection>;
  screens?: ScreenDefinition<R, TUIState, TProjection>[];
  actions: ActionDefinition<R, TActionInput, JsonValue | void>[];
};

export type Program<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
> = ProgramDefinition<R, TUIState, TUIEvent, TActionInput, TProjection> & {
  layer: Layer.Layer<R>;
  runtime: ManagedRuntime.ManagedRuntime<R, never>;
  plugins: FrameworkPlugin<R>[];
  resourceGraph: ResourceGraph<R>;
  actionByType: Map<string, ActionDefinition<R, TActionInput, JsonValue | void>>;
  screens: ScreenDefinition<R, TUIState, TProjection>[];
  screenByRoute: Map<string, ScreenDefinition<R, TUIState, TProjection>>;
  routes: RouteDefinition[];
};

export function defineProgram<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
>(
  definition: ProgramDefinition<R, TUIState, TUIEvent, TActionInput, TProjection>,
): Program<R, TUIState, TUIEvent, TActionInput, TProjection> {
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
    screens,
    screenByRoute: new Map(screens.map((screen) => [screenRoutePattern(screen), screen])),
    routes: screens.map(screenRouteDefinition).filter((route) => route !== null),
    resourceGraph,
    actionByType: new Map(definition.actions.map((action) => [String(action.type), action])),
  };
}

export function screenRoutePattern<R, TUIState, TProjection>(
  screen: ScreenDefinition<R, TUIState, TProjection>,
): string {
  return typeof screen.route === "string" ? screen.route : screen.route.pattern;
}

export function screenRouteDefinition<R, TUIState, TProjection>(
  screen: ScreenDefinition<R, TUIState, TProjection>,
): RouteDefinition | null {
  return typeof screen.route === "string" ? null : screen.route;
}

function normalizeScreens<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
>(
  definition: ProgramDefinition<R, TUIState, TUIEvent, TActionInput, TProjection>,
): ScreenDefinition<R, TUIState, TProjection>[] {
  const screens = definition.screens ?? (definition.screen ? [definition.screen] : []);

  if (screens.length === 0) {
    throw new Error("Program must define at least one screen");
  }

  return screens;
}
