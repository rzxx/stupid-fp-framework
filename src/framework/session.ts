import type { ProjectionRegionSnapshot } from "./projection";
import { acceptsSchema, type FrameworkSchema } from "./schema";

export const SESSION_SNAPSHOT_VERSION = 1;

export type Session<TState> = {
  sessionId: string;
  route: string;
  params: Record<string, string>;
  state: TState;
  projectionVersion: number;
  cursor: string | null;
  observedRegions: ProjectionRegionSnapshot[];
};

export type SessionDefinition<TState, TMessage> = {
  init: () => TState;
  accepts: (message: unknown) => message is TMessage;
  update: (state: TState, message: TMessage) => TState;
};

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

export class SessionStore<TState, TMessage> {
  readonly #definition: SessionDefinition<TState, TMessage>;
  readonly #sessions = new Map<string, Session<TState>>();
  #nextId = 1;

  constructor(definition: SessionDefinition<TState, TMessage>) {
    this.#definition = definition;
  }

  create(route: string, params: Record<string, string>): Session<TState> {
    const session: Session<TState> = {
      sessionId: `session-${this.#nextId++}`,
      route,
      params,
      state: this.#definition.init(),
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
      sessionId: snapshot.sessionId,
      route: snapshot.route,
      params: snapshot.params,
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
    session.state = this.#definition.update(session.state, message);
    return session;
  }

  bumpProjection(session: Session<TState>): number {
    session.projectionVersion += 1;
    return session.projectionVersion;
  }

  snapshot(session: Session<TState>): SessionSnapshot<TState> {
    return {
      snapshotVersion: SESSION_SNAPSHOT_VERSION,
      sessionId: session.sessionId,
      route: session.route,
      params: session.params,
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

export type SessionSnapshot<TState> = {
  snapshotVersion: number;
  sessionId: string;
  route: string;
  params: Record<string, string>;
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
