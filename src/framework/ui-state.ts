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

type UIStateBuilder<TState, TEvent extends UIEvent> = {
  event<TNextEvent extends UIEvent>(
    type: TNextEvent["type"],
    schema: FrameworkSchema<TNextEvent>,
    update: (state: TState, event: TNextEvent) => TState,
  ): UIStateBuilder<TState, TEvent | TNextEvent>;
  build(): UIStateDefinition<TState, TEvent>;
};

type UIStateInitBuilder = {
  init<TState>(init: () => TState): UIStateBuilder<TState, never>;
};

export function defineNamedUIState(_id: string): UIStateInitBuilder {
  return {
    init<TState>(init: () => TState): UIStateBuilder<TState, never> {
      const events: UIEventDefinition<TState, UIEvent>[] = [];

      function builder<TEvent extends UIEvent>(): UIStateBuilder<TState, TEvent> {
        return {
          event<TNextEvent extends UIEvent>(
            type: TNextEvent["type"],
            schema: FrameworkSchema<TNextEvent>,
            update: (state: TState, event: TNextEvent) => TState,
          ) {
            events.push({
              type,
              schema,
              update: update as (state: TState, event: UIEvent) => TState,
            });
            return builder<TEvent | TNextEvent>();
          },
          build() {
            return defineUIState<TState, TEvent>({
              init,
              events: events as UIEventDefinition<TState, TEvent>[],
            });
          },
        };
      }

      return builder();
    },
  };
}

type UIStateDefine = {
  <TState, TEvent extends UIEvent>(definition: {
    init: () => TState;
    events: UIEventDefinition<TState, TEvent>[];
  }): UIStateDefinition<TState, TEvent>;
  (id: string): UIStateInitBuilder;
};

const defineUIStateApi = ((
  definitionOrId:
    | string
    | {
        init: () => unknown;
        events: UIEventDefinition<unknown, UIEvent>[];
      },
) =>
  typeof definitionOrId === "string"
    ? defineNamedUIState(definitionOrId)
    : defineUIState(definitionOrId)) as UIStateDefine;

export const UIState: { define: UIStateDefine } = {
  define: defineUIStateApi,
};

function isUIEvent(value: unknown): value is UIEvent {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
