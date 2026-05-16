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

export const Program = {
  define(id: string) {
    return new ProgramBuilder(id);
  },
};

class ProgramBuilder<
  R = never,
  TUIState = never,
  TUIEvent extends { type: string } = never,
  TActionInput extends { type: string } = never,
  TProjection = never,
> {
  readonly #id: string;
  readonly #definition: ProgramBuilderStorage;

  constructor(
    id: string,
    definition: ProgramBuilderStorage = {
      resources: [],
      screens: [],
      actions: [],
      plugins: [],
    },
  ) {
    this.#id = id;
    this.#definition = definition;
  }

  layer<TR>(
    layer: Layer.Layer<TR>,
  ): ProgramBuilder<TR, TUIState, TUIEvent, TActionInput, TProjection> {
    return new ProgramBuilder(this.#id, {
      ...this.#definition,
      layer,
    });
  }

  plugins(
    ...plugins: FrameworkPlugin<R>[]
  ): ProgramBuilder<R, TUIState, TUIEvent, TActionInput, TProjection> {
    return new ProgramBuilder(this.#id, {
      ...this.#definition,
      plugins,
    });
  }

  resources(
    ...resources: ResourceDefinition<R, unknown>[]
  ): ProgramBuilder<R, TUIState, TUIEvent, TActionInput, TProjection> {
    return new ProgramBuilder(this.#id, {
      ...this.#definition,
      resources,
    });
  }

  ui<TNextUIState, TNextUIEvent extends { type: string }>(
    uiState: UIStateDefinition<TNextUIState, TNextUIEvent>,
  ): ProgramBuilder<R, TNextUIState, TNextUIEvent, TActionInput, TProjection> {
    return new ProgramBuilder(this.#id, {
      ...this.#definition,
      uiState,
    });
  }

  screens<TNextProjection>(
    ...screens: ScreenDefinition<R, TUIState, TNextProjection>[]
  ): ProgramBuilder<R, TUIState, TUIEvent, TActionInput, TNextProjection> {
    return new ProgramBuilder(this.#id, {
      ...this.#definition,
      screens,
    });
  }

  actions<TNextActionInput extends { type: string }>(
    ...actions: ActionDefinition<R, TNextActionInput, JsonValue | void>[]
  ): ProgramBuilder<R, TUIState, TUIEvent, TNextActionInput, TProjection> {
    return new ProgramBuilder(this.#id, {
      ...this.#definition,
      actions,
    });
  }

  build(): Program<R, TUIState, TUIEvent, TActionInput, TProjection> {
    if (!this.#definition.uiState) {
      throw new Error(`Program ${this.#id} must define UI state before build()`);
    }

    return defineProgram({
      layer: this.#definition.layer as Layer.Layer<R> | undefined,
      plugins: this.#definition.plugins as FrameworkPlugin<R>[],
      resources: this.#definition.resources as ResourceDefinition<R, unknown>[],
      uiState: this.#definition.uiState as UIStateDefinition<TUIState, TUIEvent>,
      screens: this.#definition.screens as ScreenDefinition<R, TUIState, TProjection>[],
      actions: this.#definition.actions as ActionDefinition<R, TActionInput, JsonValue | void>[],
    });
  }
}

type ProgramBuilderStorage = {
  layer?: unknown;
  resources: unknown[];
  uiState?: unknown;
  screens: unknown[];
  actions: unknown[];
  plugins: unknown[];
};

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
