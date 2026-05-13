import { describe, expect, test } from "bun:test";
import {
  connectProgramStream,
  type ConnectionState,
  type ProgramStreamSocket,
} from "../src/adapters/react/program-stream";
import type { ProjectionPatchEnvelope, ResumeResult } from "../src/framework";

type TestMessage = { type: "session.toggle" };
type TestProjection = { count: number };
type TestTrace = { traceId: string };

describe("program stream client", () => {
  test("connects with stored resume state, persists cursors, and routes patch envelopes", () => {
    const socket = new FakeSocket();
    const storage = new MemoryStorage({
      "stream-state": JSON.stringify({
        sessionId: "session-old",
        cursor: "cursor-old",
      }),
    });
    const states: ConnectionState[] = [];
    const patches: ProjectionPatchEnvelope[] = [];
    const sessions: { sessionId: string; resume: ResumeResult }[] = [];

    const client = connectProgramStream<TestMessage, TestProjection, TestTrace>({
      route: "/contract",
      params: { id: "main" },
      storageKey: "stream-state",
      environment: {
        streamUrl: "ws://test/stream",
        createSocket: () => socket,
        storage,
      },
      handlers: {
        onConnectionState: (state) => states.push(state),
        onSession: (sessionId, _resumed, resume) => {
          sessions.push({ sessionId, resume });
        },
        onProjection: () => undefined,
        onPatch: (patch) => patches.push(patch),
        onTrace: () => undefined,
        onActionResult: () => undefined,
        onError: () => undefined,
      },
    });

    socket.open();

    expect(states).toEqual(["connecting", "open"]);
    expect(socket.sent[0]).toEqual(
      JSON.stringify({
        type: "connect",
        route: "/contract",
        params: { id: "main" },
        resume: {
          sessionId: "session-old",
          cursor: "cursor-old",
        },
      }),
    );

    socket.emit({
      type: "connected",
      sessionId: "session-new",
      cursor: "cursor-1",
      resumed: true,
      resume: { status: "refreshed", reason: "stale-cursor" },
    });
    socket.emit({
      type: "projection:patch",
      sessionId: "session-new",
      cursor: "cursor-2",
      projectionVersion: 2,
      patch: {
        kind: "region-values",
        regions: [{ id: "counter", value: 2, resources: [] }],
      },
    });

    client.send({ type: "session.toggle" });

    expect(sessions.at(-1)).toEqual({
      sessionId: "session-new",
      resume: { status: "refreshed", reason: "stale-cursor" },
    });
    expect(patches).toHaveLength(1);
    expect(storage.getItem("stream-state")).toEqual(
      JSON.stringify({
        sessionId: "session-new",
        cursor: "cursor-2",
      }),
    );
    expect(socket.sent.at(-1)).toEqual(
      JSON.stringify({
        type: "message",
        sessionId: "session-new",
        message: { type: "session.toggle" },
      }),
    );
  });

  test("uses bootstrap resume state before stored resume state", () => {
    const socket = new FakeSocket();
    const storage = new MemoryStorage({
      "stream-state": JSON.stringify({
        sessionId: "session-old",
        cursor: "cursor-old",
      }),
    });

    connectProgramStream<TestMessage, TestProjection, TestTrace>({
      route: "/contract",
      params: { id: "main" },
      storageKey: "stream-state",
      bootstrap: {
        sessionId: "session-boot",
        cursor: "cursor-boot",
        resumed: false,
        resume: { status: "fresh" },
        projectionVersion: 1,
        projection: { count: 0 },
        traces: [],
      },
      environment: {
        streamUrl: "ws://test/stream",
        createSocket: () => socket,
        storage,
      },
      handlers: {
        onConnectionState: () => undefined,
        onSession: () => undefined,
        onProjection: () => undefined,
        onPatch: () => undefined,
        onTrace: () => undefined,
        onActionResult: () => undefined,
        onError: () => undefined,
      },
    });

    socket.open();

    expect(socket.sent[0]).toEqual(
      JSON.stringify({
        type: "connect",
        route: "/contract",
        params: { id: "main" },
        resume: {
          sessionId: "session-boot",
          cursor: "cursor-boot",
        },
      }),
    );
  });
});

class FakeSocket implements ProgramStreamSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>();

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  close(): void {
    this.#dispatch("close", new Event("close"));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  open(): void {
    this.#dispatch("open", new Event("open"));
  }

  emit(value: unknown): void {
    this.#dispatch("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  #dispatch(type: string, event: Event | MessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class MemoryStorage {
  readonly #values = new Map<string, string>();

  constructor(initial: Record<string, string>) {
    for (const [key, value] of Object.entries(initial)) {
      this.#values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}
