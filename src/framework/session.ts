import type { ProjectionRegionSnapshot } from "./projection";
import { acceptsSchema, type FrameworkSchema } from "./schema";
import type { UIStateDefinition } from "./ui-state";

export const SESSION_SNAPSHOT_VERSION = 1;

export type Session<TState> = {
  viewId: string;
  sessionId: string;
  route: string;
  params: Record<string, string>;
  ui: TState;
  state: TState;
  projectionVersion: number;
  cursor: string | null;
  observedRegions: ProjectionRegionSnapshot[];
};

export type ViewContext<TUIState> = Session<TUIState>;

export type SessionDefinition<TState, TMessage> = {
  init: () => TState;
  accepts: (message: unknown) => message is TMessage;
  update: (state: TState, message: TMessage) => TState;
};

export type SessionRuntimeDefinition<TState, TMessage> =
  | SessionDefinition<TState, TMessage>
  | UIStateDefinition<TState, TMessage>;

export type SessionMessageDefinition<TState, TMessage extends { type: string }> = {
  type: TMessage["type"];
  schema: FrameworkSchema<unknown>;
  update: {
    bivarianceHack(state: TState, message: TMessage): TState;
  }["bivarianceHack"];
};

export function defineSession<TState, TMessage extends { type: string }>(definition: {
  init: () => TState;
  messages: SessionMessageDefinition<TState, TMessage>[];
}): SessionDefinition<TState, TMessage> {
  const messages = new Map(
    definition.messages.map((message) => [
      message.type,
      {
        accepts: acceptsSchema(message.schema),
        update: message.update,
      },
    ]),
  );

  return {
    init: definition.init,
    accepts(message): message is TMessage {
      if (!isMessage(message)) {
        return false;
      }

      return messages.get(message.type)?.accepts(message) ?? false;
    },
    update(state, message) {
      return messages.get(message.type)?.update(state, message) ?? state;
    },
  };
}

export const Session = {
  define: defineSession,
};

export class LiveSessionRegistry<TState, TMessage> {
  readonly #definition: SessionDefinition<TState, TMessage>;
  readonly #sessions = new Map<string, Session<TState>>();
  #nextId = 1;

  constructor(definition: SessionDefinition<TState, TMessage>) {
    this.#definition = definition;
  }

  create(route: string, params: Record<string, string>): Session<TState> {
    const id = this.#nextId++;
    const viewId = `view-${id}`;
    const state = this.#definition.init();
    const session: Session<TState> = {
      viewId,
      sessionId: `session-${id}`,
      route,
      params,
      ui: state,
      state,
      projectionVersion: 0,
      cursor: null,
      observedRegions: [],
    };

    this.#sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): Session<TState> | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): Session<TState>[] {
    return [...this.#sessions.values()];
  }

  restore(snapshot: SessionSnapshot<TState>): Session<TState> {
    const session: Session<TState> = {
      viewId: snapshot.viewId ?? snapshot.sessionId,
      sessionId: snapshot.sessionId,
      route: snapshot.route,
      params: snapshot.params,
      ui: snapshot.ui ?? snapshot.state,
      state: snapshot.state,
      projectionVersion: snapshot.projectionVersion,
      cursor: snapshot.cursor,
      observedRegions: snapshot.observedRegions,
    };

    this.#sessions.set(session.sessionId, session);
    this.#advanceNextId(session.sessionId);
    return session;
  }

  update(session: Session<TState>, message: TMessage): Session<TState> {
    const next = this.#definition.update(session.ui, message);
    session.ui = next;
    session.state = next;
    return session;
  }

  bumpProjection(session: Session<TState>): number {
    session.projectionVersion += 1;
    return session.projectionVersion;
  }

  snapshot(session: Session<TState>): SessionSnapshot<TState> {
    return {
      snapshotVersion: SESSION_SNAPSHOT_VERSION,
      viewId: session.viewId,
      sessionId: session.sessionId,
      route: session.route,
      params: session.params,
      ui: session.ui,
      state: session.state,
      projectionVersion: session.projectionVersion,
      cursor: session.cursor,
      observedRegions: session.observedRegions,
    };
  }

  #advanceNextId(sessionId: string): void {
    const match = /^session-(\d+)$/.exec(sessionId);

    if (!match) {
      return;
    }

    this.#nextId = Math.max(this.#nextId, Number(match[1]) + 1);
  }
}

export { LiveSessionRegistry as SessionStore };

export type SessionSnapshot<TState> = {
  snapshotVersion: number;
  viewId?: string;
  sessionId: string;
  route: string;
  params: Record<string, string>;
  ui?: TState;
  state: TState;
  projectionVersion: number;
  cursor: string | null;
  observedRegions: ProjectionRegionSnapshot[];
};

function isMessage(value: unknown): value is { type: string } {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
