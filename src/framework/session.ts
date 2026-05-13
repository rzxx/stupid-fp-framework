export type Session<TState> = {
  sessionId: string;
  route: string;
  params: Record<string, string>;
  state: TState;
  projectionVersion: number;
};

export type SessionDefinition<TState, TMessage> = {
  init: () => TState;
  update: (state: TState, message: TMessage) => TState;
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
    };

    this.#sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): Session<TState> | undefined {
    return this.#sessions.get(sessionId);
  }

  update(session: Session<TState>, message: TMessage): Session<TState> {
    session.state = this.#definition.update(session.state, message);
    return session;
  }

  bumpProjection(session: Session<TState>): number {
    session.projectionVersion += 1;
    return session.projectionVersion;
  }
}
