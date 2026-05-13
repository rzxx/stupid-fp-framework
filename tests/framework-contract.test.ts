import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  actionFailure,
  createRuntime,
  defineAction,
  defineProgram,
  defineResource,
  Effect,
  JsonFileRuntimeStore,
  MemoryRuntimeStore,
  parseClientEnvelope,
  resourceKey,
  type ProjectionEnvelope,
  type RuntimeStore,
  type ServerEnvelope,
  type TraceEnvelope,
  type TraceSnapshot,
} from "../src/framework";

type Services = {
  counter: {
    value: number;
    writes: string[];
  };
};

type SessionState = {
  selected: boolean;
};

type SessionMessage = {
  type: "session.toggle";
};

type ActionMessage =
  | {
      type: "action.increment";
      amount: number;
    }
  | {
      type: "action.fail";
    };

type Projection = {
  route: string;
  params: Record<string, string>;
  selected: boolean;
  count: number;
  traceIds: string[];
};

const counterKey = resourceKey<number>("Counter", "main");

describe("framework contract", () => {
  test("connect accepts app-defined routes and params at the stream boundary", async () => {
    const runtime = createCounterRuntime();
    const result = await runtime.connect({
      type: "connect",
      route: "/arbitrary/:id",
      params: { id: "main", mode: "contract" },
    });

    expect(result.envelopes[0]).toMatchObject({ type: "connected" });

    const projection = latestProjection(result.envelopes).projection;
    expect(projection.route).toBe("/arbitrary/:id");
    expect(projection.params).toEqual({ id: "main", mode: "contract" });
    expect(projection.count).toBe(0);

    const envelope = latestProjection(result.envelopes);
    expect(envelope.cursor).toBeString();
    expect(envelope.regions).toEqual([
      {
        id: "counter",
        resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
      },
    ]);
  });

  test("invalidated resources map back to observed projection regions", async () => {
    const runtime = createCounterRuntime();
    const connected = await connect(runtime);

    expect(runtime.affectedRegions([counterKey])).toEqual([
      {
        sessionId: connected.sessionId,
        regions: [
          {
            id: "counter",
            resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
          },
        ],
      },
    ]);
  });

  test("session messages change ephemeral session state without changing durable resources", async () => {
    const runtime = createCounterRuntime();
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.toggle" },
    });

    const projection = latestProjection(result.envelopes).projection;
    const trace = latestTrace(result.envelopes).trace;

    expect(projection.selected).toBe(true);
    expect(projection.count).toBe(0);
    expect(trace.status).toBe("success");
    expect(trace.events.map((event) => event.label)).toContain("resources observed");
    expect(trace.events.map((event) => event.label)).toContain("projection streamed");
  });

  test("actions invalidate typed resources and projection observes the recomputed resource", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.increment", amount: 2 },
    });

    const action = result.envelopes.find((envelope) => envelope.type === "action:result");
    const projection = latestProjection(result.envelopes).projection;
    const trace = latestTrace(result.envelopes).trace;

    expect(action).toMatchObject({ ok: true, action: "increment" });
    expect(projection.count).toBe(2);
    expect(services.counter.writes).toEqual(["increment:2"]);
    expect(trace.status).toBe("success");
    expect(trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "resource",
          label: "Counter(main) invalidated",
        }),
        expect.objectContaining({
          phase: "resource",
          label: "resources invalidated",
        }),
        expect.objectContaining({
          phase: "projection",
          label: "resources observed",
          detail: { resources: ["Counter(main)"] },
        }),
      ]),
    );
  });

  test("failed actions report errors and do not mutate durable resources", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.fail" },
    });

    const action = result.envelopes.find((envelope) => envelope.type === "action:result");
    const projection = latestProjection(result.envelopes).projection;
    const trace = latestTrace(result.envelopes).trace;

    expect(action).toMatchObject({ ok: false, error: "contract failure" });
    expect(projection.count).toBe(0);
    expect(services.counter.writes).toEqual([]);
    expect(trace.status).toBe("error");
  });

  test("projection traces are scoped to the current session", async () => {
    const runtime = createCounterRuntime();
    const first = await connect(runtime);
    const second = await connect(runtime);

    const firstResult = await runtime.receive({
      type: "message",
      sessionId: first.sessionId,
      message: { type: "session.toggle" },
    });
    const firstTraceId = latestTrace(firstResult.envelopes).trace.traceId;

    const secondResult = await runtime.receive({
      type: "message",
      sessionId: second.sessionId,
      message: { type: "session.toggle" },
    });

    const secondProjection = latestProjection(secondResult.envelopes).projection;
    expect(secondProjection.traceIds).not.toContain(firstTraceId);
  });

  test("memory store can resume session state with a fresh runtime projection", async () => {
    const store = new MemoryRuntimeStore<SessionState, Projection>();
    await assertResumeRestoresSession(store);
  });

  test("JSON file store can resume session state with a fresh runtime projection", async () => {
    const store = new JsonFileRuntimeStore<SessionState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );
    await assertResumeRestoresSession(store);
  });

  test("runtime stores expose envelope history after a cursor", async () => {
    const memory = new MemoryRuntimeStore<SessionState, Projection>();
    const file = new JsonFileRuntimeStore<SessionState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );

    await assertStoreEnvelopeHistory(memory);
    await assertStoreEnvelopeHistory(file);
  });

  test("resume with missed envelopes replays history instead of recomputing immediately", async () => {
    const store = new MemoryRuntimeStore<SessionState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connect(firstRuntime);

    const updated = await firstRuntime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.toggle" },
    });
    const earlierCursor = latestProjection(updated.envelopes).cursor;

    await firstRuntime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.toggle" },
    });

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
      resume: {
        sessionId: connected.sessionId,
        cursor: earlierCursor,
      },
    });

    expect(resumed.envelopes[0]).toMatchObject({
      type: "connected",
      resumed: true,
      resume: { status: "replayed" },
    });
    expect(resumed.envelopes.some((envelope) => envelope.type === "trace:update")).toBe(true);
  });

  test("resume with route mismatch creates a fresh session with an explicit rejection", async () => {
    const store = new MemoryRuntimeStore<SessionState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connect(firstRuntime);

    const updated = await firstRuntime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.toggle" },
    });
    const resumeCursor = latestTrace(updated.envelopes).cursor;

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/different/:id",
      params: { id: "main" },
      resume: {
        sessionId: connected.sessionId,
        cursor: resumeCursor,
      },
    });

    expect(resumed.envelopes[0]).toMatchObject({
      type: "connected",
      resumed: false,
      resume: { status: "rejected", reason: "route-mismatch" },
    });
    expect(latestProjection(resumed.envelopes).projection.selected).toBe(false);
  });

  test("resume with stale cursor restores session and refreshes projection", async () => {
    const store = new MemoryRuntimeStore<SessionState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connect(firstRuntime);

    await firstRuntime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.toggle" },
    });

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
      resume: {
        sessionId: connected.sessionId,
        cursor: "cursor-missing",
      },
    });

    expect(resumed.envelopes[0]).toMatchObject({
      type: "connected",
      resumed: true,
      resume: { status: "refreshed", reason: "stale-cursor" },
    });
    expect(latestProjection(resumed.envelopes).projection.selected).toBe(true);
  });

  test("stream parser rejects params that are not string records", () => {
    expect(
      parseClientEnvelope(
        JSON.stringify({
          type: "connect",
          route: "/anything",
          params: { id: 123 },
        }),
      ),
    ).toMatchObject({ type: "error", message: "Invalid connect envelope" });
  });
});

function createServices(): Services {
  return {
    counter: {
      value: 0,
      writes: [],
    },
  };
}

function createCounterRuntime(
  services = createServices(),
  store?: RuntimeStore<SessionState, Projection>,
) {
  const program = defineProgram<Services, SessionState, SessionMessage, ActionMessage, Projection>({
    services,
    resources: [defineResource<Services, number>("Counter", (services) => services.counter.value)],
    session: {
      init: () => ({ selected: false }),
      update: (state, message) => {
        if (message.type === "session.toggle") {
          return { selected: !state.selected };
        }

        return state;
      },
    },
    screen: {
      route: "/contract",
      project: async (session, context) => ({
        route: session.route,
        params: session.params,
        selected: session.state.selected,
        count: await context.region("counter", () =>
          context.resources.read(context.services, counterKey),
        ),
        traceIds: context.traces.list().map((trace) => trace.traceId),
      }),
    },
    actions: [
      defineAction<Services, Extract<ActionMessage, { type: "action.increment" }>>(
        "action.increment",
        (message, context) =>
          Effect.sync(() => {
            context.services.counter.value += message.amount;
            context.services.counter.writes.push(`increment:${message.amount}`);
            context.invalidate(counterKey);
          }),
      ),
      defineAction<Services, Extract<ActionMessage, { type: "action.fail" }>>("action.fail", () =>
        Effect.fail(actionFailure("contract failure")),
      ),
    ],
  });

  return createRuntime(program, { store });
}

async function connect(runtime: ReturnType<typeof createCounterRuntime>) {
  const result = await runtime.connect({
    type: "connect",
    route: "/contract/:id",
    params: { id: "main" },
  });
  const connected = result.envelopes.find((envelope) => envelope.type === "connected");

  if (!connected) {
    throw new Error("Expected connected envelope");
  }

  return { sessionId: connected.sessionId };
}

function latestProjection(
  envelopes: ServerEnvelope<Projection, TraceSnapshot>[],
): ProjectionEnvelope<Projection> {
  const projection = envelopes.find(
    (envelope): envelope is ProjectionEnvelope<Projection> => envelope.type === "projection:update",
  );

  if (!projection) {
    throw new Error("Expected projection envelope");
  }

  return projection;
}

function latestTrace(
  envelopes: ServerEnvelope<Projection, TraceSnapshot>[],
): TraceEnvelope<TraceSnapshot> {
  const trace = envelopes.find(
    (envelope): envelope is TraceEnvelope<TraceSnapshot> => envelope.type === "trace:update",
  );

  if (!trace) {
    throw new Error("Expected trace envelope");
  }

  return trace;
}

async function assertResumeRestoresSession(store: RuntimeStore<SessionState, Projection>) {
  const services = createServices();
  const firstRuntime = createCounterRuntime(services, store);
  const connected = await connect(firstRuntime);

  const updated = await firstRuntime.receive({
    type: "message",
    sessionId: connected.sessionId,
    message: { type: "session.toggle" },
  });
  const resumeCursor = latestTrace(updated.envelopes).cursor;

  const resumedRuntime = createCounterRuntime(services, store);
  const resumed = await resumedRuntime.connect({
    type: "connect",
    route: "/contract/:id",
    params: { id: "main" },
    resume: {
      sessionId: connected.sessionId,
      cursor: resumeCursor,
    },
  });

  expect(resumed.envelopes[0]).toMatchObject({
    type: "connected",
    sessionId: connected.sessionId,
    resumed: true,
    resume: { status: "refreshed", reason: "current-cursor" },
  });
  expect(latestProjection(resumed.envelopes).projection.selected).toBe(true);
}

async function assertStoreEnvelopeHistory(store: RuntimeStore<SessionState, Projection>) {
  const firstCursor = await store.nextCursor();
  await store.appendEnvelope("session-x", firstCursor, {
    type: "connected",
    sessionId: "session-x",
    cursor: firstCursor,
    resumed: false,
    resume: { status: "fresh" },
  });

  const secondCursor = await store.nextCursor();
  await store.appendEnvelope("session-x", secondCursor, {
    type: "projection:update",
    sessionId: "session-x",
    cursor: secondCursor,
    projectionVersion: 1,
    projection: {
      route: "/contract/:id",
      params: { id: "main" },
      selected: false,
      count: 0,
      traceIds: [],
    },
    regions: [],
  });

  expect(await store.readEnvelopesAfter("session-x", firstCursor)).toMatchObject([
    {
      sessionId: "session-x",
      cursor: secondCursor,
      envelope: { type: "projection:update" },
    },
  ]);
}
