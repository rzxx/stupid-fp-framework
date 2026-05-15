import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ViewCheckpoint } from "./view";
import type { ServerEnvelope } from "./stream";
import type { TraceSnapshot } from "./trace";
import type { ProjectionRegionSnapshot } from "./projection";
import type { SerializedResourceKey } from "./resource";

export const RUNTIME_STORE_PROTOCOL_VERSION = 1;

export type RuntimeStoreCapabilities = {
  ephemeral: boolean;
  singleProcess: boolean;
  singleWriter: boolean;
  supportsRangeRead: boolean;
  supportsCompaction: boolean;
  supportsPubSub: boolean;
  supportsObservationIndex: boolean;
  supportsAtomicCommit: boolean;
  supportsInputIdempotency: boolean;
  retention: "unbounded" | "adapter-defined";
};

export type RuntimeStoreErrorReason =
  | "read-failed"
  | "write-failed"
  | "corrupt-store"
  | "commit-conflict"
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

export type RuntimeEnvelopeWrite<TProjection, TTrace = TraceSnapshot> = {
  viewId: string;
  envelope: ServerEnvelope<TProjection, TTrace>;
};

export type RuntimeViewWrite<TUIState> = {
  checkpoint: ViewCheckpoint<TUIState>;
  expectedRevision?: number;
};

export type RuntimeObservationWrite = {
  fanoutScope: string;
  viewId: string;
  regions: ProjectionRegionSnapshot[];
};

export type RuntimeInputRecord = {
  clientInputId: string;
  viewId: string;
  status: "accepted" | "committed" | "failed";
};

export type RuntimeStoreCommit<TUIState, TProjection, TTrace = TraceSnapshot> = {
  envelopes?: RuntimeEnvelopeWrite<TProjection, TTrace>[];
  views?: RuntimeViewWrite<TUIState>[];
  observations?: RuntimeObservationWrite[];
  inputRecords?: RuntimeInputRecord[];
};

export type RuntimeStoreCommitResult<TUIState, TProjection, TTrace = TraceSnapshot> = {
  envelopes: StoredEnvelope<TProjection, TTrace>[];
  views: ViewCheckpoint<TUIState>[];
};

export type ObservationIndexMatch = {
  viewId: string;
  regions: ProjectionRegionSnapshot[];
};

export type RuntimeStore<TUIState, TProjection, TTrace = TraceSnapshot> = {
  capabilities: RuntimeStoreCapabilities;
  commitInvocation: (
    commit: RuntimeStoreCommit<TUIState, TProjection, TTrace>,
  ) => Promise<RuntimeStoreCommitResult<TUIState, TProjection, TTrace>>;
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
  replaceViewObservations: (write: RuntimeObservationWrite) => Promise<void>;
  findViewsObserving: (
    fanoutScope: string,
    keys: readonly SerializedResourceKey[],
  ) => Promise<ObservationIndexMatch[]>;
  readInputRecord: (clientInputId: string) => Promise<RuntimeInputRecord | null>;
};

type StoredState<TUIState, TProjection, TTrace> = {
  protocolVersion: number;
  nextCursor: number;
  views: ViewCheckpoint<TUIState>[];
  envelopes: StoredEnvelope<TProjection, TTrace>[];
  observations: RuntimeObservationWrite[];
  inputRecords: RuntimeInputRecord[];
};

export class MemoryRuntimeStore<
  TUIState,
  TProjection,
  TTrace = TraceSnapshot,
> implements RuntimeStore<TUIState, TProjection, TTrace> {
  readonly capabilities: RuntimeStoreCapabilities = {
    ephemeral: true,
    singleProcess: true,
    singleWriter: true,
    supportsRangeRead: true,
    supportsCompaction: false,
    supportsPubSub: false,
    supportsObservationIndex: true,
    supportsAtomicCommit: true,
    supportsInputIdempotency: true,
    retention: "unbounded",
  };

  readonly #views = new Map<string, ViewCheckpoint<TUIState>>();
  readonly #envelopes: StoredEnvelope<TProjection, TTrace>[] = [];
  readonly #observations = new Map<string, RuntimeObservationWrite>();
  readonly #inputRecords = new Map<string, RuntimeInputRecord>();
  #nextCursor = 1;

  async commitInvocation(
    commit: RuntimeStoreCommit<TUIState, TProjection, TTrace>,
  ): Promise<RuntimeStoreCommitResult<TUIState, TProjection, TTrace>> {
    const envelopes = this.#commitEnvelopes(commit.envelopes ?? []);
    const views = this.#commitViews(commit.views ?? [], envelopes);

    for (const observation of commit.observations ?? []) {
      this.#replaceViewObservations(observation);
    }

    for (const record of commit.inputRecords ?? []) {
      this.#inputRecords.set(record.clientInputId, record);
    }

    return { envelopes, views };
  }

  async saveView(snapshot: ViewCheckpoint<TUIState>): Promise<void> {
    await this.commitInvocation({ views: [{ checkpoint: snapshot }] });
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

  async replaceViewObservations(write: RuntimeObservationWrite): Promise<void> {
    this.#replaceViewObservations(write);
  }

  async findViewsObserving(
    fanoutScope: string,
    keys: readonly SerializedResourceKey[],
  ): Promise<ObservationIndexMatch[]> {
    return findObservationMatches([...this.#observations.values()], fanoutScope, keys);
  }

  async readInputRecord(clientInputId: string): Promise<RuntimeInputRecord | null> {
    return this.#inputRecords.get(clientInputId) ?? null;
  }

  #commitEnvelopes(
    writes: RuntimeEnvelopeWrite<TProjection, TTrace>[],
  ): StoredEnvelope<TProjection, TTrace>[] {
    return writes.map((write) => {
      const cursor = `cursor-${this.#nextCursor++}`;
      const envelope = withCursor(write.envelope, cursor);
      const stored = { viewId: write.viewId, cursor, envelope };

      this.#envelopes.push(stored);
      return stored;
    });
  }

  #commitViews(
    writes: RuntimeViewWrite<TUIState>[],
    envelopes: StoredEnvelope<TProjection, TTrace>[],
  ): ViewCheckpoint<TUIState>[] {
    const committed: ViewCheckpoint<TUIState>[] = [];

    for (const write of writes) {
      const current = this.#views.get(write.checkpoint.viewId);
      const currentRevision = current?.checkpointRevision ?? 0;

      if (write.expectedRevision !== undefined && write.expectedRevision !== currentRevision) {
        throw runtimeStoreError(
          "commit-conflict",
          `Checkpoint ${write.checkpoint.viewId} expected revision ${write.expectedRevision} but found ${currentRevision}`,
        );
      }

      const cursor =
        [...envelopes].reverse().find((entry) => entry.viewId === write.checkpoint.viewId)
          ?.cursor ??
        write.checkpoint.cursor ??
        null;
      const checkpoint = {
        ...write.checkpoint,
        fanoutScope: write.checkpoint.fanoutScope ?? "global",
        checkpointRevision: currentRevision + 1,
        cursor,
      };

      this.#views.set(checkpoint.viewId, checkpoint);
      committed.push(checkpoint);
    }

    return committed;
  }

  #replaceViewObservations(write: RuntimeObservationWrite): void {
    this.#observations.set(write.viewId, {
      fanoutScope: write.fanoutScope,
      viewId: write.viewId,
      regions: write.regions,
    });
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
    singleWriter: true,
    supportsRangeRead: true,
    supportsCompaction: false,
    supportsPubSub: false,
    supportsObservationIndex: true,
    supportsAtomicCommit: true,
    supportsInputIdempotency: true,
    retention: "adapter-defined",
  };

  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async commitInvocation(
    commit: RuntimeStoreCommit<TUIState, TProjection, TTrace>,
  ): Promise<RuntimeStoreCommitResult<TUIState, TProjection, TTrace>> {
    const state = await this.#read();
    const envelopes = commitEnvelopes(state, commit.envelopes ?? []);
    const views = commitViews(state, commit.views ?? [], envelopes);

    for (const observation of commit.observations ?? []) {
      state.observations = state.observations.filter(
        (entry) => entry.viewId !== observation.viewId,
      );
      state.observations.push(observation);
    }

    for (const record of commit.inputRecords ?? []) {
      state.inputRecords = state.inputRecords.filter(
        (entry) => entry.clientInputId !== record.clientInputId,
      );
      state.inputRecords.push(record);
    }

    await this.#write(state);
    return { envelopes, views };
  }

  async saveView(snapshot: ViewCheckpoint<TUIState>): Promise<void> {
    await this.commitInvocation({ views: [{ checkpoint: snapshot }] });
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

  async replaceViewObservations(write: RuntimeObservationWrite): Promise<void> {
    const state = await this.#read();
    state.observations = state.observations.filter((entry) => entry.viewId !== write.viewId);
    state.observations.push(write);
    await this.#write(state);
  }

  async findViewsObserving(
    fanoutScope: string,
    keys: readonly SerializedResourceKey[],
  ): Promise<ObservationIndexMatch[]> {
    const state = await this.#read();
    return findObservationMatches(state.observations, fanoutScope, keys);
  }

  async readInputRecord(clientInputId: string): Promise<RuntimeInputRecord | null> {
    const state = await this.#read();
    return state.inputRecords.find((entry) => entry.clientInputId === clientInputId) ?? null;
  }

  async #read(): Promise<StoredState<TUIState, TProjection, TTrace>> {
    try {
      const content = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(content) as Partial<StoredState<TUIState, TProjection, TTrace>>;

      if (!isStoredState(parsed)) {
        throw runtimeStoreError("corrupt-store", `Runtime store ${this.#path} has invalid shape`);
      }

      return {
        ...(parsed as StoredState<TUIState, TProjection, TTrace>),
        observations: parsed.observations ?? [],
        inputRecords: parsed.inputRecords ?? [],
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          protocolVersion: RUNTIME_STORE_PROTOCOL_VERSION,
          nextCursor: 1,
          views: [],
          envelopes: [],
          observations: [],
          inputRecords: [],
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
      JSON.stringify(
        {
          ...state,
          protocolVersion: RUNTIME_STORE_PROTOCOL_VERSION,
          observations: state.observations ?? [],
          inputRecords: state.inputRecords ?? [],
        },
        null,
        2,
      ),
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

function commitEnvelopes<TProjection, TTrace>(
  state: StoredState<unknown, TProjection, TTrace>,
  writes: RuntimeEnvelopeWrite<TProjection, TTrace>[],
): StoredEnvelope<TProjection, TTrace>[] {
  return writes.map((write) => {
    const cursor = `cursor-${state.nextCursor++}`;
    const envelope = withCursor(write.envelope, cursor);
    const stored = { viewId: write.viewId, cursor, envelope };

    state.envelopes.push(stored);
    return stored;
  });
}

function commitViews<TUIState, TProjection, TTrace>(
  state: StoredState<TUIState, TProjection, TTrace>,
  writes: RuntimeViewWrite<TUIState>[],
  envelopes: StoredEnvelope<TProjection, TTrace>[],
): ViewCheckpoint<TUIState>[] {
  const committed: ViewCheckpoint<TUIState>[] = [];

  for (const write of writes) {
    const current = state.views.find((view) => view.viewId === write.checkpoint.viewId);
    const currentRevision = current?.checkpointRevision ?? 0;

    if (write.expectedRevision !== undefined && write.expectedRevision !== currentRevision) {
      throw runtimeStoreError(
        "commit-conflict",
        `Checkpoint ${write.checkpoint.viewId} expected revision ${write.expectedRevision} but found ${currentRevision}`,
      );
    }

    const cursor =
      [...envelopes].reverse().find((entry) => entry.viewId === write.checkpoint.viewId)?.cursor ??
      write.checkpoint.cursor ??
      null;
    const checkpoint = {
      ...write.checkpoint,
      fanoutScope: write.checkpoint.fanoutScope ?? "global",
      checkpointRevision: currentRevision + 1,
      cursor,
    };

    state.views = state.views.filter((view) => view.viewId !== checkpoint.viewId);
    state.views.push(checkpoint);
    committed.push(checkpoint);
  }

  return committed;
}

function withCursor<TProjection, TTrace>(
  envelope: ServerEnvelope<TProjection, TTrace>,
  cursor: string,
): ServerEnvelope<TProjection, TTrace> {
  if ("cursor" in envelope) {
    return { ...envelope, cursor };
  }

  return envelope;
}

function findObservationMatches(
  observations: RuntimeObservationWrite[],
  fanoutScope: string,
  keys: readonly SerializedResourceKey[],
): ObservationIndexMatch[] {
  const invalidated = new Set(keys.map((key) => `${key.type}:${key.id}`));
  const matches: ObservationIndexMatch[] = [];

  for (const observation of observations) {
    if (observation.fanoutScope !== fanoutScope) {
      continue;
    }

    const regions = observation.regions.filter((region) =>
      region.resources.some((resource) => invalidated.has(`${resource.type}:${resource.id}`)),
    );

    if (regions.length > 0) {
      matches.push({ viewId: observation.viewId, regions });
    }
  }

  return matches;
}
