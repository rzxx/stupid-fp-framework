import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ViewCheckpoint } from "./view";
import type { ServerEnvelope } from "./stream";
import type { TraceSnapshot } from "./trace";

export const RUNTIME_STORE_PROTOCOL_VERSION = 1;

export type RuntimeStoreCapabilities = {
  ephemeral: boolean;
  singleProcess: boolean;
  supportsRangeRead: boolean;
  supportsCompaction: boolean;
  supportsPubSub: boolean;
  supportsObservationIndex: boolean;
  retention: "unbounded" | "adapter-defined";
};

export type RuntimeStoreErrorReason =
  | "read-failed"
  | "write-failed"
  | "corrupt-store"
  | "unsupported-operation";

export class RuntimeStoreError extends Error {
  readonly type = "store-error";
  readonly reason: RuntimeStoreErrorReason;
  readonly cause?: unknown;

  constructor(reason: RuntimeStoreErrorReason, message: string, cause?: unknown) {
    super(message);
    this.name = "RuntimeStoreError";
    this.reason = reason;
    this.cause = cause;
  }
}

export function runtimeStoreError(
  reason: RuntimeStoreErrorReason,
  message: string,
  cause?: unknown,
): RuntimeStoreError {
  return new RuntimeStoreError(reason, message, cause);
}

export type StoredEnvelope<TProjection, TTrace = TraceSnapshot> = {
  viewId: string;
  cursor: string;
  envelope: ServerEnvelope<TProjection, TTrace>;
};

export type RuntimeStore<TUIState, TProjection, TTrace = TraceSnapshot> = {
  capabilities: RuntimeStoreCapabilities;
  saveView: (checkpoint: ViewCheckpoint<TUIState>) => Promise<void>;
  loadView: (viewId: string) => Promise<ViewCheckpoint<TUIState> | null>;
  listViews: () => Promise<ViewCheckpoint<TUIState>[]>;
  nextCursor: () => Promise<string>;
  appendEnvelope: (
    viewId: string,
    cursor: string,
    envelope: ServerEnvelope<TProjection, TTrace>,
  ) => Promise<void>;
  readEnvelopesAfter: (
    viewId: string,
    cursor: string,
  ) => Promise<StoredEnvelope<TProjection, TTrace>[]>;
  hasEnvelopeCursor: (viewId: string, cursor: string) => Promise<boolean>;
};

type StoredState<TUIState, TProjection, TTrace> = {
  protocolVersion: number;
  nextCursor: number;
  views: ViewCheckpoint<TUIState>[];
  envelopes: StoredEnvelope<TProjection, TTrace>[];
};

export class MemoryRuntimeStore<
  TUIState,
  TProjection,
  TTrace = TraceSnapshot,
> implements RuntimeStore<TUIState, TProjection, TTrace> {
  readonly capabilities: RuntimeStoreCapabilities = {
    ephemeral: true,
    singleProcess: true,
    supportsRangeRead: true,
    supportsCompaction: false,
    supportsPubSub: false,
    supportsObservationIndex: true,
    retention: "unbounded",
  };

  readonly #views = new Map<string, ViewCheckpoint<TUIState>>();
  readonly #envelopes: StoredEnvelope<TProjection, TTrace>[] = [];
  #nextCursor = 1;

  async saveView(snapshot: ViewCheckpoint<TUIState>): Promise<void> {
    this.#views.set(snapshot.viewId, snapshot);
  }

  async loadView(viewId: string): Promise<ViewCheckpoint<TUIState> | null> {
    return this.#views.get(viewId) ?? null;
  }

  async listViews(): Promise<ViewCheckpoint<TUIState>[]> {
    return [...this.#views.values()].map((view) => ({ ...view }));
  }

  async nextCursor(): Promise<string> {
    const cursor = `cursor-${this.#nextCursor++}`;
    return cursor;
  }

  async appendEnvelope(
    viewId: string,
    cursor: string,
    envelope: ServerEnvelope<TProjection, TTrace>,
  ): Promise<void> {
    this.#envelopes.push({ viewId, cursor, envelope });
  }

  async readEnvelopesAfter(
    viewId: string,
    cursor: string,
  ): Promise<StoredEnvelope<TProjection, TTrace>[]> {
    const index = this.#envelopes.findIndex(
      (entry) => entry.viewId === viewId && entry.cursor === cursor,
    );

    if (index === -1) {
      return [];
    }

    return this.#envelopes
      .slice(index + 1)
      .filter((entry) => entry.viewId === viewId)
      .map((entry) => ({ ...entry }));
  }

  async hasEnvelopeCursor(viewId: string, cursor: string): Promise<boolean> {
    return this.#envelopes.some((entry) => entry.viewId === viewId && entry.cursor === cursor);
  }
}

export class JsonFileRuntimeStore<
  TUIState,
  TProjection,
  TTrace = TraceSnapshot,
> implements RuntimeStore<TUIState, TProjection, TTrace> {
  readonly capabilities: RuntimeStoreCapabilities = {
    ephemeral: false,
    singleProcess: true,
    supportsRangeRead: true,
    supportsCompaction: false,
    supportsPubSub: false,
    supportsObservationIndex: true,
    retention: "adapter-defined",
  };

  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async saveView(snapshot: ViewCheckpoint<TUIState>): Promise<void> {
    const state = await this.#read();
    state.views = state.views.filter((view) => view.viewId !== snapshot.viewId);
    state.views.push(snapshot);
    await this.#write(state);
  }

  async loadView(viewId: string): Promise<ViewCheckpoint<TUIState> | null> {
    const state = await this.#read();
    return state.views.find((view) => view.viewId === viewId) ?? null;
  }

  async listViews(): Promise<ViewCheckpoint<TUIState>[]> {
    const state = await this.#read();
    return state.views;
  }

  async nextCursor(): Promise<string> {
    const state = await this.#read();
    const cursor = `cursor-${state.nextCursor++}`;
    await this.#write(state);
    return cursor;
  }

  async appendEnvelope(
    viewId: string,
    cursor: string,
    envelope: ServerEnvelope<TProjection, TTrace>,
  ): Promise<void> {
    const state = await this.#read();
    state.envelopes.push({ viewId, cursor, envelope });
    await this.#write(state);
  }

  async readEnvelopesAfter(
    viewId: string,
    cursor: string,
  ): Promise<StoredEnvelope<TProjection, TTrace>[]> {
    const state = await this.#read();
    const index = state.envelopes.findIndex(
      (entry) => entry.viewId === viewId && entry.cursor === cursor,
    );

    if (index === -1) {
      return [];
    }

    return state.envelopes.slice(index + 1).filter((entry) => entry.viewId === viewId);
  }

  async hasEnvelopeCursor(viewId: string, cursor: string): Promise<boolean> {
    const state = await this.#read();
    return state.envelopes.some((entry) => entry.viewId === viewId && entry.cursor === cursor);
  }

  async #read(): Promise<StoredState<TUIState, TProjection, TTrace>> {
    try {
      const content = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(content) as Partial<StoredState<TUIState, TProjection, TTrace>>;

      if (!isStoredState(parsed)) {
        throw runtimeStoreError("corrupt-store", `Runtime store ${this.#path} has invalid shape`);
      }

      return parsed as StoredState<TUIState, TProjection, TTrace>;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          protocolVersion: RUNTIME_STORE_PROTOCOL_VERSION,
          nextCursor: 1,
          views: [],
          envelopes: [],
        };
      }

      if (error instanceof SyntaxError) {
        throw runtimeStoreError(
          "corrupt-store",
          `Runtime store ${this.#path} is not valid JSON`,
          error,
        );
      }

      throw error;
    }
  }

  async #write(state: StoredState<TUIState, TProjection, TTrace>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(
      this.#path,
      JSON.stringify({ ...state, protocolVersion: RUNTIME_STORE_PROTOCOL_VERSION }, null, 2),
    );
  }
}

function isStoredState(value: Partial<StoredState<unknown, unknown, unknown>>): boolean {
  return (
    value.protocolVersion === RUNTIME_STORE_PROTOCOL_VERSION &&
    typeof value.nextCursor === "number" &&
    Array.isArray(value.views) &&
    Array.isArray(value.envelopes)
  );
}
