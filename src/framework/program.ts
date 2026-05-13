import type { ActionDefinition } from "./action";
import { Layer, ManagedRuntime } from "./effect";
import type { JsonValue } from "./json";
import { ResourceGraph, type ResourceDefinition } from "./resource";
import type { ScreenDefinition } from "./projection";
import type { SessionDefinition } from "./session";

export type ProgramDefinition<
  R,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = {
  layer?: Layer.Layer<R>;
  resources: ResourceDefinition<R, unknown>[];
  session: SessionDefinition<TSessionState, TSessionMessage>;
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
  resourceGraph: ResourceGraph<R>;
  actionByType: Map<string, ActionDefinition<R, TActionMessage, JsonValue | void>>;
  screens: ScreenDefinition<R, TSessionState, TProjection>[];
  screenByRoute: Map<string, ScreenDefinition<R, TSessionState, TProjection>>;
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
  const resourceGraph = new ResourceGraph<R>();
  const screens = normalizeScreens(definition);
  const layer = definition.layer ?? (Layer.empty as Layer.Layer<R>);

  for (const resource of definition.resources) {
    resourceGraph.register(resource);
  }

  return {
    ...definition,
    layer,
    runtime: ManagedRuntime.make(layer),
    screens,
    screenByRoute: new Map(screens.map((screen) => [screen.route, screen])),
    resourceGraph,
    actionByType: new Map(definition.actions.map((action) => [String(action.type), action])),
  };
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
