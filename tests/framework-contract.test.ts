import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  actionFailure,
  Action,
  createRuntime,
  defineProgram,
  defineResource,
  Context,
  Effect,
  JsonFileRuntimeStore,
  Layer,
  LiveSessionRegistry,
  MemoryRuntimeStore,
  parseClientEnvelope,
  ResourceGraph,
  Route,
  resourceKey,
  Schema,
  Session,
  type ProjectionEnvelope,
  type ProjectionPatchEnvelope,
  type FrameworkPlugin,
  type RuntimeStoreCapabilities,
  RuntimeStoreError,
  type RuntimeStore,
  type ServerEnvelope,
  type TraceEnvelope,
  type TraceSnapshot,
  TraceStore,
} from "../src/framework";

type Services = {
  counter: {
    value: number;
    writes: string[];
  };
};

class CounterService extends Context.Tag("test/CounterService")<
  CounterService,
  Services["counter"]
>() {}

type TestEnvironment = CounterService;

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
const counterRoute = Route.define("/contract/:id", {
  params: Schema.Struct({ id: Schema.String }),
});
const incrementSchema = Schema.Struct({
  type: Schema.Literal("action.increment"),
  amount: Schema.Number,
});
const failSchema = Schema.Struct({
  type: Schema.Literal("action.fail"),
});
const toggleSchema = Schema.Struct({
  type: Schema.Literal("session.toggle"),
});
const counterSession = Session.define<SessionState, SessionMessage>({
  init: () => ({ selected: false }),
  messages: [
    {
      type: "session.toggle",
      schema: toggleSchema,
      update: (state) => ({ selected: !state.selected }),
    },
  ],
});

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
    expect(envelope.regions).toEqual(
      expect.arrayContaining([
        {
          id: "counter",
          value: 0,
          resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
        },
      ]),
    );
  });

  test("programs can route connections to one of multiple registered screens", async () => {
    const runtime = createMultiScreenRuntime();

    const first = await runtime.connect({
      type: "connect",
      route: "/first",
      params: {},
    });
    const second = await runtime.connect({
      type: "connect",
      route: "/second",
      params: {},
    });

    expect(latestProjection(first.envelopes).projection.route).toBe("/first");
    expect(latestProjection(second.envelopes).projection.route).toBe("/second");
  });

  test("route definitions resolve concrete paths and decode params", async () => {
    const runtime = createCounterRuntime();
    const result = await runtime.connect({
      type: "connect",
      route: "/contract/main",
      params: {},
    });

    const projection = latestProjection(result.envelopes).projection;
    expect(projection.route).toBe("/contract/:id");
    expect(projection.params).toEqual({ id: "main" });
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
            value: 0,
            resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
          },
        ],
      },
    ]);
  });

  test("concurrent resource observation keeps regions isolated per projection", async () => {
    const graph = new ResourceGraph<TestEnvironment>();
    graph.register(
      defineResource<TestEnvironment, number>("Counter", (key) =>
        Effect.gen(function* () {
          const counter = yield* CounterService;

          if (key.id === "slow") {
            yield* Effect.promise(() => delay(10));
          }

          return counter.value;
        }),
      ),
    );
    const services = createServices();
    const layer = createServicesLayer(services);
    const slowKey = resourceKey<number>("Counter", "slow");
    const fastKey = resourceKey<number>("Counter", "fast");

    const [slow, fast] = await Promise.all([
      graph.observe(() =>
        Effect.runPromise(
          Effect.provide(
            graph.region("slow-region", () => graph.read(slowKey)),
            layer,
          ),
        ),
      ),
      graph.observe(() =>
        Effect.runPromise(
          Effect.provide(
            graph.region("fast-region", () => graph.read(fastKey)),
            layer,
          ),
        ),
      ),
    ]);

    expect(slow.regions).toEqual([
      {
        id: "slow-region",
        value: 0,
        resources: [{ type: "Counter", id: "slow", label: "Counter(slow)" }],
      },
    ]);
    expect(fast.regions).toEqual([
      {
        id: "fast-region",
        value: 0,
        resources: [{ type: "Counter", id: "fast", label: "Counter(fast)" }],
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

    const projection = applyCounterPatch(connected.projection, latestPatch(result.envelopes));
    const trace = latestTrace(result.envelopes).trace;

    expect(projection.selected).toBe(true);
    expect(projection.count).toBe(0);
    expect(trace.status).toBe("success");
    expect(trace.events.map((event) => event.label)).toContain("resources observed");
    expect(trace.events.map((event) => event.label)).toContain("region patch streamed");
  });

  test("view context exposes UI checkpoint state separately from live session compatibility", () => {
    const registry = new LiveSessionRegistry(counterSession);
    const view = registry.create("/contract/:id", { id: "main" });

    registry.update(view, { type: "session.toggle" });
    const snapshot = registry.snapshot(view);

    expect(view.viewId).toBe("view-1");
    expect(view.sessionId).toBe("session-1");
    expect(view.ui).toEqual({ selected: true });
    expect(view.state).toEqual(view.ui);
    expect(snapshot).toMatchObject({
      viewId: "view-1",
      sessionId: "session-1",
      ui: { selected: true },
      state: { selected: true },
    });
  });

  test("unknown messages are rejected instead of being treated as session updates", async () => {
    const runtime = createCounterRuntime();
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.unknown" } as unknown as SessionMessage,
    });

    expect(result.envelopes[0]).toMatchObject({
      type: "error",
      sessionId: connected.sessionId,
      message: "Unknown message type: session.unknown",
    });
    expect(latestTrace(result.envelopes).trace.status).toBe("error");
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
    const patch = latestPatch(result.envelopes);
    const projection = applyCounterPatch(connected.projection, patch);
    const trace = latestTrace(result.envelopes).trace;

    expect(action).toMatchObject({ ok: true, action: "increment" });
    expect(action).toMatchObject({ result: { count: 2 } });
    expect(patch.patch.regions).toEqual([
      {
        id: "counter",
        value: 2,
        resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
      },
    ]);
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
          label: "regions invalidated",
          detail: {
            sessionId: connected.sessionId,
            regions: ["counter"],
          },
        }),
        expect.objectContaining({
          phase: "projection",
          label: "resources observed",
          detail: { resources: ["Counter(main)"] },
        }),
        expect.objectContaining({
          phase: "stream",
          label: "region patch streamed",
          detail: {
            sessionId: connected.sessionId,
            projectionVersion: 2,
            regions: ["counter"],
          },
        }),
      ]),
    );
  });

  test("plugins can observe actions resources sessions routes and traces", async () => {
    const observed: string[] = [];
    const plugin: FrameworkPlugin<TestEnvironment> = {
      name: "contract-observer",
      hooks: {
        action: {
          before: ({ actionType }) =>
            Effect.sync(() => {
              observed.push(`action:before:${actionType}`);
            }),
          after: ({ actionType, ok }) =>
            Effect.sync(() => {
              observed.push(`action:after:${actionType}:${ok}`);
            }),
        },
        resource: {
          beforeRead: ({ key }) =>
            Effect.sync(() => {
              observed.push(`resource:read:${key.label}`);
            }),
          invalidate: ({ keys }) =>
            Effect.sync(() => {
              observed.push(`resource:invalidate:${keys.map((key) => key.label).join(",")}`);
            }),
        },
        route: {
          resolve: ({ matchedRoute }) =>
            Effect.sync(() => {
              observed.push(`route:${matchedRoute ?? "none"}`);
            }),
        },
        session: {
          create: ({ session }) =>
            Effect.sync(() => {
              observed.push(`session:create:${session.sessionId}`);
            }),
          update: ({ message }) =>
            Effect.sync(() => {
              observed.push(`session:update:${message.type}`);
            }),
        },
        trace: {
          event: ({ event }) =>
            Effect.sync(() => {
              observed.push(`trace:${event.label}`);
            }),
        },
      },
    };
    const runtime = createCounterRuntime(createServices(), undefined, [plugin]);
    const connected = await connectWithEnvelope(runtime);

    await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.toggle" },
    });
    await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.increment", amount: 1 },
    });

    expect(observed).toContain("route:/contract/:id");
    expect(observed).toContain("session:create:session-1");
    expect(observed).toContain("session:update:session.toggle");
    expect(observed).toContain("action:before:action.increment");
    expect(observed).toContain("action:after:action.increment:true");
    expect(observed).toContain("resource:read:Counter(main)");
    expect(observed).toContain("resource:invalidate:Counter(main)");
    expect(observed).toContain("trace:message received");
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
    const trace = latestTrace(result.envelopes).trace;

    expect(action).toMatchObject({ ok: false, error: "contract failure" });
    expect(result.envelopes.some((envelope) => envelope.type === "projection:update")).toBe(false);
    expect(result.envelopes.some((envelope) => envelope.type === "projection:patch")).toBe(false);
    expect(connected.projection.count).toBe(0);
    expect(services.counter.writes).toEqual([]);
    expect(trace.status).toBe("error");
  });

  test("invalid action payloads fail before effects mutate durable resources", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.increment", amount: "nope" } as unknown as ActionMessage,
    });

    const action = result.envelopes.find((envelope) => envelope.type === "action:result");
    const trace = latestTrace(result.envelopes).trace;

    expect(action).toMatchObject({
      ok: false,
      error: "Invalid action payload: action.increment",
    });
    expect(services.counter.value).toBe(0);
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

    const secondProjection = applyCounterPatch(
      second.projection,
      latestPatch(secondResult.envelopes),
    );
    expect(secondProjection.traceIds).not.toContain(firstTraceId);
  });

  test("trace store keeps dev-only events out of browser snapshots", () => {
    const traces = new TraceStore();
    const trace = traces.start("contract", { scopeId: "session-1" });

    traces.add(trace, "message", "browser event");
    traces.add(trace, "auth", "dev credential detail", { token: "secret" }, { visibility: "dev" });

    expect(traces.list("session-1")).toEqual([
      expect.objectContaining({
        events: [expect.objectContaining({ label: "browser event" })],
      }),
    ]);
    expect(traces.list("session-1", "dev")[0]?.events.map((event) => event.label)).toEqual([
      "browser event",
      "dev credential detail",
    ]);
  });

  test("external resource invalidation fans out patches to affected sessions", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const first = await connect(runtime);
    const second = await connect(runtime);

    services.counter.value = 7;
    const result = await runtime.invalidate([counterKey]);

    const patches = result.envelopes.filter(
      (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
    );

    expect(patches.map((patch) => patch.sessionId).sort()).toEqual(
      [first.sessionId, second.sessionId].sort(),
    );
    expect(patches.map((patch) => applyCounterPatch(first.projection, patch).count)).toEqual([
      7, 7,
    ]);
    expect(result.envelopes.some((envelope) => envelope.type === "projection:update")).toBe(false);
  });

  test("action invalidation sends trace envelopes to every affected session", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const first = await connect(runtime);
    const second = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: first.sessionId,
      message: { type: "action.increment", amount: 1 },
    });

    const secondPatch = result.envelopes.find(
      (envelope): envelope is ProjectionPatchEnvelope =>
        envelope.type === "projection:patch" && envelope.sessionId === second.sessionId,
    );
    const secondTrace = result.envelopes.find(
      (envelope): envelope is TraceEnvelope<TraceSnapshot> =>
        envelope.type === "trace:update" && envelope.sessionId === second.sessionId,
    );

    expect(secondPatch?.causedByTraceId).toBe(secondTrace?.trace.traceId);
  });

  test("unpatchable region values fall back to full projection updates", async () => {
    const services = createServices();
    const runtime = createUnpatchableRegionRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.increment", amount: 1 },
    });

    expect(result.envelopes.some((envelope) => envelope.type === "projection:patch")).toBe(false);
    expect(latestProjection(result.envelopes).projection.count).toBe(1);
    expect(latestTrace(result.envelopes).trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "stream",
          label: "projection fallback streamed",
        }),
      ]),
    );
  });

  test("projection failures return error envelopes instead of throwing", async () => {
    const runtime = createFailingProjectionRuntime();
    const result = await runtime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
    });

    expect(result.envelopes[0]).toMatchObject({ type: "connected" });
    expect(result.envelopes[1]).toMatchObject({
      type: "error",
      message: "projection exploded",
    });
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

  test("runtime stores expose durability capability metadata", () => {
    const memory = new MemoryRuntimeStore<SessionState, Projection>();
    const file = new JsonFileRuntimeStore<SessionState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );

    expect(memory.capabilities).toMatchObject({
      ephemeral: true,
      singleProcess: true,
      supportsRangeRead: true,
    } satisfies Partial<RuntimeStoreCapabilities>);
    expect(file.capabilities).toMatchObject({
      ephemeral: false,
      singleProcess: true,
      supportsRangeRead: true,
    } satisfies Partial<RuntimeStoreCapabilities>);
  });

  test("JSON file store reports corrupted state as a typed store failure", async () => {
    const path = join(tmpdir(), `stupid-fp-framework-corrupt-${crypto.randomUUID()}.json`);
    await writeFile(path, "{ nope", "utf8");
    const store = new JsonFileRuntimeStore<SessionState, Projection>(path);

    await expect(store.loadSession("session-1")).rejects.toBeInstanceOf(RuntimeStoreError);
    await expect(store.loadSession("session-1")).rejects.toMatchObject({
      type: "store-error",
      reason: "corrupt-store",
    });
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
    const earlierCursor = latestPatch(updated.envelopes).cursor;

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

  test("resume with patch-only missed history includes a projection baseline", async () => {
    const store = new MemoryRuntimeStore<SessionState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connectWithEnvelope(firstRuntime);

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
        cursor: connected.projectionEnvelope.cursor,
      },
    });

    expect(resumed.envelopes[0]).toMatchObject({
      type: "connected",
      resumed: true,
      resume: { status: "replayed" },
    });
    expect(resumed.envelopes[1]).toMatchObject({ type: "projection:update" });
    expect(resumed.envelopes.some((envelope) => envelope.type === "projection:patch")).toBe(true);
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

  test("stream parser rejects message payloads without a string type", () => {
    expect(
      parseClientEnvelope(
        JSON.stringify({
          type: "message",
          sessionId: "session-1",
          message: { payload: true },
        }),
      ),
    ).toMatchObject({ type: "error", message: "Invalid message envelope" });
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

function createServicesLayer(services: Services): Layer.Layer<TestEnvironment> {
  return Layer.succeed(CounterService, services.counter);
}

function createCounterRuntime(
  services = createServices(),
  store?: RuntimeStore<SessionState, Projection>,
  plugins: FrameworkPlugin<TestEnvironment>[] = [],
) {
  const program = defineProgram<
    TestEnvironment,
    SessionState,
    SessionMessage,
    ActionMessage,
    Projection
  >({
    layer: createServicesLayer(services),
    plugins,
    resources: [
      defineResource<TestEnvironment, number>("Counter", () =>
        Effect.map(CounterService, (counter) => counter.value),
      ),
    ],
    session: counterSession,
    screen: {
      route: counterRoute,
      project: (session, context) =>
        Effect.gen(function* () {
          return {
            route: session.route,
            params: session.params,
            selected: yield* context.region("selected", () =>
              Effect.succeed(session.state.selected),
            ),
            count: yield* context.region("counter", () => context.resources.read(counterKey)),
            traceIds: yield* context.region("traceIds", () =>
              Effect.succeed(context.traces.list().map((trace) => trace.traceId)),
            ),
          };
        }),
    },
    actions: [
      Action.define("action.increment")
        .input(incrementSchema)
        .run<{ count: number }, TestEnvironment>((message, context) =>
          Effect.gen(function* () {
            const counter = yield* CounterService;
            counter.value += message.amount;
            counter.writes.push(`increment:${message.amount}`);
            context.invalidate(counterKey);
            return { count: counter.value };
          }),
        ),
      Action.define("action.fail")
        .input(failSchema)
        .run(() => Effect.fail(actionFailure("contract failure"))),
    ],
  });

  return createRuntime(program, { store });
}

function createUnpatchableRegionRuntime(
  services = createServices(),
  store?: RuntimeStore<SessionState, Projection>,
) {
  const program = defineProgram<
    TestEnvironment,
    SessionState,
    SessionMessage,
    ActionMessage,
    Projection
  >({
    layer: createServicesLayer(services),
    resources: [
      defineResource<TestEnvironment, number>("Counter", () =>
        Effect.map(CounterService, (counter) => counter.value),
      ),
    ],
    session: Session.define<SessionState, SessionMessage>({
      init: () => ({ selected: false }),
      messages: [
        {
          type: "session.toggle",
          schema: toggleSchema,
          update: (state) => state,
        },
      ],
    }),
    screen: {
      route: "/contract",
      project: (session, context) =>
        Effect.gen(function* () {
          const counter = yield* context.region("counter", () =>
            Effect.map(context.resources.read(counterKey), (count) => ({
              count,
              unpatchable: () => undefined,
            })),
          );

          return {
            route: session.route,
            params: session.params,
            selected: session.state.selected,
            count: counter.count,
            traceIds: [],
          };
        }),
    },
    actions: [
      Action.define("action.increment")
        .input(incrementSchema)
        .run<{ count: number }, TestEnvironment>((message, context) =>
          Effect.gen(function* () {
            const counter = yield* CounterService;
            counter.value += message.amount;
            context.invalidate(counterKey);
            return { count: counter.value };
          }),
        ),
    ],
  });

  return createRuntime(program, { store });
}

function createFailingProjectionRuntime() {
  const program = defineProgram<
    TestEnvironment,
    SessionState,
    SessionMessage,
    ActionMessage,
    Projection
  >({
    layer: createServicesLayer(createServices()),
    resources: [],
    session: Session.define<SessionState, SessionMessage>({
      init: () => ({ selected: false }),
      messages: [
        {
          type: "session.toggle",
          schema: toggleSchema,
          update: (state) => state,
        },
      ],
    }),
    screen: {
      route: "/contract",
      project: () => Effect.die(new Error("projection exploded")),
    },
    actions: [],
  });

  return createRuntime(program);
}

function createMultiScreenRuntime() {
  const program = defineProgram<
    TestEnvironment,
    SessionState,
    SessionMessage,
    ActionMessage,
    Projection
  >({
    layer: createServicesLayer(createServices()),
    resources: [
      defineResource<TestEnvironment, number>("Counter", () =>
        Effect.map(CounterService, (counter) => counter.value),
      ),
    ],
    session: Session.define<SessionState, SessionMessage>({
      init: () => ({ selected: false }),
      messages: [
        {
          type: "session.toggle",
          schema: toggleSchema,
          update: (state) => state,
        },
      ],
    }),
    screens: [
      {
        route: "/first",
        project: (session, context) =>
          Effect.map(context.resources.read(counterKey), (count) => ({
            route: session.route,
            params: session.params,
            selected: session.state.selected,
            count,
            traceIds: [],
          })),
      },
      {
        route: "/second",
        project: (session, context) =>
          Effect.map(context.resources.read(counterKey), (count) => ({
            route: session.route,
            params: session.params,
            selected: session.state.selected,
            count,
            traceIds: [],
          })),
      },
    ],
    actions: [],
  });

  return createRuntime(program);
}

async function connect(runtime: ReturnType<typeof createCounterRuntime>) {
  const connected = await connectWithEnvelope(runtime);

  return { sessionId: connected.sessionId, projection: connected.projectionEnvelope.projection };
}

async function connectWithEnvelope(runtime: ReturnType<typeof createCounterRuntime>) {
  const result = await runtime.connect({
    type: "connect",
    route: "/contract/:id",
    params: { id: "main" },
  });
  const connected = result.envelopes.find((envelope) => envelope.type === "connected");

  if (!connected) {
    throw new Error("Expected connected envelope");
  }

  const projection = latestProjection(result.envelopes);

  return { sessionId: connected.sessionId, projectionEnvelope: projection };
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

function latestPatch(
  envelopes: ServerEnvelope<Projection, TraceSnapshot>[],
): ProjectionPatchEnvelope {
  const patch = envelopes.find(
    (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
  );

  if (!patch) {
    throw new Error("Expected projection patch envelope");
  }

  return patch;
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

function applyCounterPatch(projection: Projection, patch: ProjectionPatchEnvelope): Projection {
  return patch.patch.regions.reduce((current, region) => {
    if (region.id === "counter" && typeof region.value === "number") {
      return { ...current, count: region.value };
    }

    if (region.id === "selected" && typeof region.value === "boolean") {
      return { ...current, selected: region.value };
    }

    if (
      region.id === "traceIds" &&
      Array.isArray(region.value) &&
      region.value.every((value) => typeof value === "string")
    ) {
      return { ...current, traceIds: region.value };
    }

    return current;
  }, projection);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
