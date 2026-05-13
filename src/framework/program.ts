import type { ActionDefinition } from "./action";
import type { JsonValue } from "./json";
import { ResourceGraph, type ResourceDefinition } from "./resource";
import type { ScreenDefinition } from "./projection";
import type { SessionDefinition } from "./session";

export type ProgramDefinition<
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = {
  services: TServices;
  resources: ResourceDefinition<TServices, unknown>[];
  session: SessionDefinition<TSessionState, TSessionMessage>;
  screen?: ScreenDefinition<TServices, TSessionState, TProjection>;
  screens?: ScreenDefinition<TServices, TSessionState, TProjection>[];
  actions: ActionDefinition<TServices, TActionMessage, JsonValue | void>[];
};

export type Program<
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = ProgramDefinition<TServices, TSessionState, TSessionMessage, TActionMessage, TProjection> & {
  resourceGraph: ResourceGraph<TServices>;
  actionByType: Map<string, ActionDefinition<TServices, TActionMessage, JsonValue | void>>;
  screens: ScreenDefinition<TServices, TSessionState, TProjection>[];
  screenByRoute: Map<string, ScreenDefinition<TServices, TSessionState, TProjection>>;
};

export function defineProgram<
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  definition: ProgramDefinition<
    TServices,
    TSessionState,
    TSessionMessage,
    TActionMessage,
    TProjection
  >,
): Program<TServices, TSessionState, TSessionMessage, TActionMessage, TProjection> {
  const resourceGraph = new ResourceGraph<TServices>();
  const screens = normalizeScreens(definition);

  for (const resource of definition.resources) {
    resourceGraph.register(resource);
  }

  return {
    ...definition,
    screens,
    screenByRoute: new Map(screens.map((screen) => [screen.route, screen])),
    resourceGraph,
    actionByType: new Map(definition.actions.map((action) => [String(action.type), action])),
  };
}

function normalizeScreens<
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  definition: ProgramDefinition<
    TServices,
    TSessionState,
    TSessionMessage,
    TActionMessage,
    TProjection
  >,
): ScreenDefinition<TServices, TSessionState, TProjection>[] {
  const screens = definition.screens ?? (definition.screen ? [definition.screen] : []);

  if (screens.length === 0) {
    throw new Error("Program must define at least one screen");
  }

  return screens;
}
