import { describe, expect, test } from "bun:test";
import {
  connectProgramStream,
  type ConnectionState,
  type ProgramStreamSocket,
} from "../src/adapters/react/program-stream";
import type { ProjectionPatchEnvelope, ResumeResult } from "../src/framework";

type TestMessage = { type: "view.toggle" };
type TestProjection = { count: number };
type TestTrace = { traceId: string };

describe("program stream client", () => {
  test("connects with stored resume state, persists cursors, and routes patch envelopes", () => {
    const socket = new FakeSocket();
    const storage = new MemoryStorage({
      "stream-state": JSON.stringify({
        viewId: "view-old",
        cursor: "cursor-old",
      }),
    });
    const states: ConnectionState[] = [];
    const patches: ProjectionPatchEnvelope[] = [];
    const views: { viewId: string; resume: ResumeResult }[] = [];

    const client = connectProgramStream<TestMessage, TestProjection, TestTrace>({
      route: "/contract",
      params: { id: "main" },
      storageKey: "stream-state",
      environment: {
        streamUrl: "ws://test/stream",
        createClientInputId: () => "client-input-test",
        createSocket: () => socket,
        storage,
      },
      handlers: {
        onConnectionState: (state) => states.push(state),
        onView: (viewId, _resumed, resume) => {
          views.push({ viewId, resume });
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
          viewId: "view-old",
          cursor: "cursor-old",
        },
      }),
    );

    socket.emit({
      type: "connected",
      viewId: "view-new",
      cursor: "cursor-1",
      resumed: true,
      resume: { status: "refreshed", reason: "stale-cursor" },
    });
    socket.emit({
      type: "projection:patch",
      viewId: "view-new",
      cursor: "cursor-2",
      projectionVersion: 2,
      patch: {
        kind: "region-values",
        regions: [{ id: "counter", value: 2, resources: [] }],
      },
    });

    client.send({ type: "view.toggle" });

    expect(views.at(-1)).toEqual({
      viewId: "view-new",
      resume: { status: "refreshed", reason: "stale-cursor" },
    });
    expect(patches).toHaveLength(1);
    expect(storage.getItem("stream-state")).toEqual(
      JSON.stringify({
        viewId: "view-new",
        cursor: "cursor-2",
      }),
    );
    expect(socket.sent.at(-1)).toEqual(
      JSON.stringify({
        type: "input",
        viewId: "view-new",
        clientInputId: "client-input-test",
        input: { type: "view.toggle" },
      }),
    );
  });

  test("reconnects with latest cursor and reports malformed envelopes without killing recovery", () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const timers = new FakeTimers();
    const storage = new MemoryStorage({
      "stream-state": JSON.stringify({
        viewId: "view-old",
        cursor: "cursor-old",
      }),
    });
    const states: ConnectionState[] = [];
    const errors: string[] = [];

    connectProgramStream<TestMessage, TestProjection, TestTrace>({
      route: "/contract",
      params: { id: "main" },
      storageKey: "stream-state",
      reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: false },
      environment: {
        streamUrl: "ws://test/stream",
        createSocket: () => {
          const socket = sockets.shift();

          if (!socket) {
            throw new Error("Unexpected socket creation");
          }

          return socket;
        },
        storage,
        timers,
      },
      handlers: {
        onConnectionState: (state) => states.push(state),
        onView: () => undefined,
        onProjection: () => undefined,
        onPatch: () => undefined,
        onTrace: () => undefined,
        onActionResult: () => undefined,
        onError: (error) => errors.push(error.message),
      },
    });

    first.open();
    first.emit({
      type: "connected",
      viewId: "view-new",
      cursor: "cursor-1",
      resumed: true,
      resume: { status: "replayed", replayed: 1 },
    });
    first.emitRaw("{ nope");
    first.close();

    expect(errors).toEqual(["Malformed server envelope"]);
    expect(timers.scheduled).toEqual([10]);

    timers.runNext();
    second.open();

    expect(states).toEqual(["connecting", "open", "closed", "connecting", "open"]);
    expect(second.sent[0]).toEqual(
      JSON.stringify({
        type: "connect",
        route: "/contract",
        params: { id: "main" },
        resume: {
          viewId: "view-new",
          cursor: "cursor-1",
        },
      }),
    );
  });

  test("rejects sends while disconnected", () => {
    const socket = new FakeSocket();
    const errors: string[] = [];
    const client = connectProgramStream<TestMessage, TestProjection, TestTrace>({
      route: "/contract",
      params: { id: "main" },
      reconnect: { enabled: false },
      environment: {
        streamUrl: "ws://test/stream",
        createSocket: () => socket,
      },
      handlers: {
        onConnectionState: () => undefined,
        onView: () => undefined,
        onProjection: () => undefined,
        onPatch: () => undefined,
        onTrace: () => undefined,
        onActionResult: () => undefined,
        onError: (error) => errors.push(error.message),
      },
    });

    expect(client.send({ type: "view.toggle" })).toBeUndefined();
    expect(errors).toEqual(["Cannot send while stream is disconnected"]);
  });

  test("uses bootstrap resume state before stored resume state", () => {
    const socket = new FakeSocket();
    const storage = new MemoryStorage({
      "stream-state": JSON.stringify({
        viewId: "view-old",
        cursor: "cursor-old",
      }),
    });

    connectProgramStream<TestMessage, TestProjection, TestTrace>({
      route: "/contract",
      params: { id: "main" },
      storageKey: "stream-state",
      bootstrap: {
        viewId: "view-boot",
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
        onView: () => undefined,
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
          viewId: "view-boot",
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

  emitRaw(value: string): void {
    this.#dispatch("message", new MessageEvent("message", { data: value }));
  }

  #dispatch(type: string, event: Event | MessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeTimers {
  readonly scheduled: number[] = [];
  readonly #handlers: (() => void)[] = [];

  setTimeout(handler: () => void, timeout: number): number {
    this.scheduled.push(timeout);
    this.#handlers.push(handler);
    return this.#handlers.length;
  }

  clearTimeout(id: unknown): void {
    const index = typeof id === "number" ? id - 1 : -1;

    if (index >= 0) {
      this.#handlers.splice(index, 1);
      this.scheduled.splice(index, 1);
    }
  }

  runNext(): void {
    const handler = this.#handlers.shift();
    this.scheduled.shift();
    handler?.();
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
