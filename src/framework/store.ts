import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionSnapshot } from "./session";
import type { ServerEnvelope } from "./stream";
import type { TraceSnapshot } from "./trace";

export type StoredEnvelope<TProjection, TTrace = TraceSnapshot> = {
  sessionId: string;
  cursor: string;
  envelope: ServerEnvelope<TProjection, TTrace>;
};

export type RuntimeStore<TSessionState, TProjection, TTrace = TraceSnapshot> = {
  saveSession: (snapshot: SessionSnapshot<TSessionState>) => Promise<void>;
  loadSession: (sessionId: string) => Promise<SessionSnapshot<TSessionState> | null>;
  nextCursor: () => Promise<string>;
  appendEnvelope: (
    sessionId: string,
    cursor: string,
    envelope: ServerEnvelope<TProjection, TTrace>,
  ) => Promise<void>;
  readEnvelopesAfter: (
    sessionId: string,
    cursor: string,
  ) => Promise<StoredEnvelope<TProjection, TTrace>[]>;
};

type StoredState<TSessionState, TProjection, TTrace> = {
  nextCursor: number;
  sessions: SessionSnapshot<TSessionState>[];
  envelopes: StoredEnvelope<TProjection, TTrace>[];
};

export class MemoryRuntimeStore<
  TSessionState,
  TProjection,
  TTrace = TraceSnapshot,
> implements RuntimeStore<TSessionState, TProjection, TTrace> {
  readonly #sessions = new Map<string, SessionSnapshot<TSessionState>>();
  readonly #envelopes: StoredEnvelope<TProjection, TTrace>[] = [];
  #nextCursor = 1;

  async saveSession(snapshot: SessionSnapshot<TSessionState>): Promise<void> {
    this.#sessions.set(snapshot.sessionId, snapshot);
  }

  async loadSession(sessionId: string): Promise<SessionSnapshot<TSessionState> | null> {
    return this.#sessions.get(sessionId) ?? null;
  }

  async nextCursor(): Promise<string> {
    const cursor = `cursor-${this.#nextCursor++}`;
    return cursor;
  }

  async appendEnvelope(
    sessionId: string,
    cursor: string,
    envelope: ServerEnvelope<TProjection, TTrace>,
  ): Promise<void> {
    this.#envelopes.push({ sessionId, cursor, envelope });
  }

  async readEnvelopesAfter(
    sessionId: string,
    cursor: string,
  ): Promise<StoredEnvelope<TProjection, TTrace>[]> {
    const index = this.#envelopes.findIndex(
      (entry) => entry.sessionId === sessionId && entry.cursor === cursor,
    );

    if (index === -1) {
      return [];
    }

    return this.#envelopes
      .slice(index + 1)
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => ({ ...entry }));
  }
}

export class JsonFileRuntimeStore<
  TSessionState,
  TProjection,
  TTrace = TraceSnapshot,
> implements RuntimeStore<TSessionState, TProjection, TTrace> {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async saveSession(snapshot: SessionSnapshot<TSessionState>): Promise<void> {
    const state = await this.#read();
    state.sessions = state.sessions.filter((session) => session.sessionId !== snapshot.sessionId);
    state.sessions.push(snapshot);
    await this.#write(state);
  }

  async loadSession(sessionId: string): Promise<SessionSnapshot<TSessionState> | null> {
    const state = await this.#read();
    return state.sessions.find((session) => session.sessionId === sessionId) ?? null;
  }

  async nextCursor(): Promise<string> {
    const state = await this.#read();
    const cursor = `cursor-${state.nextCursor++}`;
    await this.#write(state);
    return cursor;
  }

  async appendEnvelope(
    sessionId: string,
    cursor: string,
    envelope: ServerEnvelope<TProjection, TTrace>,
  ): Promise<void> {
    const state = await this.#read();
    state.envelopes.push({ sessionId, cursor, envelope });
    await this.#write(state);
  }

  async readEnvelopesAfter(
    sessionId: string,
    cursor: string,
  ): Promise<StoredEnvelope<TProjection, TTrace>[]> {
    const state = await this.#read();
    const index = state.envelopes.findIndex(
      (entry) => entry.sessionId === sessionId && entry.cursor === cursor,
    );

    if (index === -1) {
      return [];
    }

    return state.envelopes.slice(index + 1).filter((entry) => entry.sessionId === sessionId);
  }

  async #read(): Promise<StoredState<TSessionState, TProjection, TTrace>> {
    try {
      const content = await readFile(this.#path, "utf8");
      return JSON.parse(content) as StoredState<TSessionState, TProjection, TTrace>;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { nextCursor: 1, sessions: [], envelopes: [] };
      }

      throw error;
    }
  }

  async #write(state: StoredState<TSessionState, TProjection, TTrace>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(state, null, 2));
  }
}
