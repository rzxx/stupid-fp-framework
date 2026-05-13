import { describe, expect, test } from "bun:test";
import {
  actionFailure,
  createRuntime,
  defineAction,
  defineProgram,
  defineResource,
  Effect,
  parseClientEnvelope,
  resourceKey,
  type ProjectionEnvelope,
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

function createCounterRuntime(services = createServices()) {
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
        count: await context.resources.read(context.services, counterKey),
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

  return createRuntime(program);
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
