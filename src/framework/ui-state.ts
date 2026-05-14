import { acceptsSchema, type FrameworkSchema } from "./schema";

export type UIEvent<TType extends string = string> = {
  type: TType;
};

export type UIStateDefinition<TState, TEvent> = {
  init: () => TState;
  accepts: (event: unknown) => event is TEvent;
  update: (state: TState, event: TEvent) => TState;
};

export type UIEventDefinition<TState, TEvent extends UIEvent> = {
  type: TEvent["type"];
  schema: FrameworkSchema<unknown>;
  update: {
    bivarianceHack(state: TState, event: TEvent): TState;
  }["bivarianceHack"];
};

export function defineUIState<TState, TEvent extends UIEvent>(definition: {
  init: () => TState;
  events: UIEventDefinition<TState, TEvent>[];
}): UIStateDefinition<TState, TEvent> {
  const events = new Map(
    definition.events.map((event) => [
      event.type,
      {
        accepts: acceptsSchema(event.schema),
        update: event.update,
      },
    ]),
  );

  return {
    init: definition.init,
    accepts(event): event is TEvent {
      if (!isUIEvent(event)) {
        return false;
      }

      return events.get(event.type)?.accepts(event) ?? false;
    },
    update(state, event) {
      return events.get(event.type)?.update(state, event) ?? state;
    },
  };
}

export const UIState = {
  define: defineUIState,
};

function isUIEvent(value: unknown): value is UIEvent {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
