import type { ActionDefinition } from "./action";
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
  screen: ScreenDefinition<TServices, TSessionState, TProjection>;
  actions: ActionDefinition<TServices, TActionMessage>[];
};

export type Program<
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = ProgramDefinition<TServices, TSessionState, TSessionMessage, TActionMessage, TProjection> & {
  resourceGraph: ResourceGraph<TServices>;
  actionByType: Map<string, ActionDefinition<TServices, TActionMessage>>;
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

  for (const resource of definition.resources) {
    resourceGraph.register(resource);
  }

  return {
    ...definition,
    resourceGraph,
    actionByType: new Map(definition.actions.map((action) => [String(action.type), action])),
  };
}
