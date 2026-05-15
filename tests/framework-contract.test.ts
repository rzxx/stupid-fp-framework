import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  actionFailure,
  Action,
  createRuntime,
  createStatelessRuntime,
  defineProgram,
  defineResource,
  Context,
  Effect,
  InvocationContext,
  JsonFileRuntimeStore,
  Layer,
  MemoryRuntimeStore,
  parseClientEnvelope,
  Program,
  Resource,
  ResourceGraph,
  Route,
  Screen,
  resourceKey,
  Schema,
  UIState,
  type ProjectionEnvelope,
  type ProjectionPatchEnvelope,
  type ProjectionContext,
  type FrameworkPlugin,
  type RuntimeStoreCapabilities,
  RuntimeStoreError,
  type RuntimeStore,
  type ServerEnvelope,
  type TraceEnvelope,
  type TraceSnapshot,
  TraceStore,
  type ViewCheckpoint,
  type ViewContext,
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

type UIState = {
  selected: boolean;
};

type UIEvent = {
  type: "view.toggle";
};

type ActionInput =
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
  type: Schema.Literal("view.toggle"),
});
const counterUIState = UIState.define<UIState, UIEvent>({
  init: () => ({ selected: false }),
  events: [
    {
      type: "view.toggle",
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

  test("runtime results expose protocol events and delivery intents", async () => {
    const runtime = createCounterRuntime();
    const result = await runtime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
    });
    const connected = result.envelopes.find((envelope) => envelope.type === "connected");

    if (!connected) {
      throw new Error("Expected connected envelope");
    }

    expect(result.protocolEvents?.map((event) => event.type)).toEqual([
      "view.connected",
      "projection.updated",
    ]);
    expect(result.deliveryIntents?.map((intent) => intent.viewId)).toEqual([
      connected.viewId,
      connected.viewId,
    ]);
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

  test("named builder APIs compose resources UI state screens and programs", async () => {
    const BuiltCounter = Resource.define("BuiltCounter")
      .value<number>()
      .key<{ id: string }>(Schema.Struct({ id: Schema.String }), {
        id: (params) => params.id,
      })
      .load<TestEnvironment>(() => Effect.map(CounterService, (counter) => counter.value));
    const builtUI = UIState.define("built.ui")
      .init<UIState>(() => ({ selected: false }))
      .event<UIEvent>("view.toggle", toggleSchema, (state) => ({
        selected: !state.selected,
      }))
      .build();
    const builtScreen = Screen.define("built.counter")
      .route("/built/:id", { params: Schema.Struct({ id: Schema.String }) })
      .project((view: ViewContext<UIState>, context: ProjectionContext<TestEnvironment>) =>
        Effect.gen(function* () {
          const projection: Projection = {
            route: view.route,
            params: view.params,
            selected: view.ui.selected,
            count: yield* context.region("counter", () =>
              context.resources.read(BuiltCounter.key({ id: view.params.id as string })),
            ),
            traceIds: [],
          };

          return projection;
        }),
      );
    const runtime = createRuntime(
      Program.define("built")
        .layer<TestEnvironment>(createServicesLayer(createServices()))
        .resources(BuiltCounter)
        .ui<UIState, UIEvent>(builtUI)
        .screens<Projection>(builtScreen)
        .build(),
    );
    const result = await runtime.connect({
      type: "connect",
      route: "/built/main",
      params: {},
    });

    expect(latestProjection(result.envelopes).projection).toMatchObject({
      route: "/built/:id",
      count: 0,
    });
  });

  test("invalidated resources map back to observed projection regions", async () => {
    const runtime = createCounterRuntime();
    const connected = await connect(runtime);

    expect(runtime.affectedRegions([counterKey])).toEqual([
      {
        viewId: connected.viewId,
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

  test("UI events change ephemeral view state without changing durable resources", async () => {
    const runtime = createCounterRuntime();
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });

    const projection = applyCounterPatch(connected.projection, latestPatch(result.envelopes));
    const trace = latestTrace(result.envelopes).trace;

    expect(projection.selected).toBe(true);
    expect(projection.count).toBe(0);
    expect(trace.status).toBe("success");
    expect(trace.events.map((event) => event.label)).toContain("resources observed");
    expect(trace.events.map((event) => event.label)).toContain("region patch streamed");
  });

  test("unknown inputs are rejected instead of being treated as view updates", async () => {
    const runtime = createCounterRuntime();
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.unknown" } as unknown as UIEvent,
    });

    expect(result.envelopes[0]).toMatchObject({
      type: "error",
      viewId: connected.viewId,
      message: "Unknown input type: view.unknown",
    });
    expect(latestTrace(result.envelopes).trace.status).toBe("error");
  });

  test("actions invalidate typed resources and projection observes the recomputed resource", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.increment", amount: 2 },
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
            viewId: connected.viewId,
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
            viewId: connected.viewId,
            projectionVersion: 2,
            regions: ["counter"],
          },
        }),
      ]),
    );
  });

  test("client input ids flow through action results and input records", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const runtime = createCounterRuntime(services, store);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      clientInputId: "client-input-1",
      input: { type: "action.increment", amount: 1 },
    });
    const lifecycle = result.envelopes.find((envelope) => envelope.type === "action:lifecycle");
    const action = result.envelopes.find((envelope) => envelope.type === "action:result");

    expect(lifecycle).toMatchObject({
      clientInputId: "client-input-1",
      stage: "started",
    });
    expect(action).toMatchObject({
      clientInputId: "client-input-1",
      ok: true,
    });
    expect(await store.readInputRecord("client-input-1")).toEqual({
      clientInputId: "client-input-1",
      viewId: connected.viewId,
      status: "committed",
    });
  });

  test("plugins can observe actions resources views routes and traces", async () => {
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
        view: {
          create: ({ view }) =>
            Effect.sync(() => {
              observed.push(`view:create:${view.viewId}`);
            }),
          update: ({ input }) =>
            Effect.sync(() => {
              observed.push(`view:update:${input.type}`);
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
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });
    await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.increment", amount: 1 },
    });

    expect(observed).toContain("route:/contract/:id");
    expect(observed.some((entry) => entry.startsWith("view:create:"))).toBe(true);
    expect(observed).toContain("view:update:view.toggle");
    expect(observed).toContain("action:before:action.increment");
    expect(observed).toContain("action:after:action.increment:true");
    expect(observed).toContain("resource:read:Counter(main)");
    expect(observed).toContain("resource:invalidate:Counter(main)");
    expect(observed).toContain("trace:input received");
  });

  test("invocation context is provided through Effect per input", async () => {
    type AuthInput = { type: "action.whoami" };
    const runtime = createRuntime(
      defineProgram<TestEnvironment | InvocationContext, UIState, UIEvent, AuthInput, Projection>({
        layer: createServicesLayer(createServices()) as Layer.Layer<
          TestEnvironment | InvocationContext
        >,
        resources: [
          defineResource<TestEnvironment | InvocationContext, number>("Counter", () =>
            Effect.map(CounterService, (counter) => counter.value),
          ),
        ],
        uiState: counterUIState,
        screen: {
          route: counterRoute,
          project: (view, context) =>
            Effect.gen(function* () {
              const invocation = yield* InvocationContext;

              return {
                route: view.route,
                params: view.params,
                selected: view.ui.selected,
                count: yield* context.region("counter", () => context.resources.read(counterKey)),
                traceIds: [invocation.fanoutScope],
              };
            }),
        },
        actions: [
          Action.define("action.whoami")
            .input(Schema.Struct({ type: Schema.Literal("action.whoami") }))
            .run<{ principalId: string }, TestEnvironment | InvocationContext>(() =>
              Effect.map(InvocationContext, (context) => ({
                principalId: context.principal?.id ?? "anonymous",
              })),
            ),
        ],
      }),
      {
        fanoutScope: () => "team-context",
        invocationContext: () => ({
          principal: { id: "user-context" },
        }),
      },
    );
    const connected = await connect(runtime as unknown as ReturnType<typeof createCounterRuntime>);
    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.whoami" },
    });
    const action = result.envelopes.find((envelope) => envelope.type === "action:result");

    expect(connected.projection.traceIds).toEqual(["team-context"]);
    expect(action).toMatchObject({
      ok: true,
      result: { principalId: "user-context" },
    });
  });

  test("failed actions report errors and do not mutate durable resources", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.fail" },
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
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.increment", amount: "nope" } as unknown as ActionInput,
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

  test("projection traces are scoped to the current view", async () => {
    const runtime = createCounterRuntime();
    const first = await connect(runtime);
    const second = await connect(runtime);

    const firstResult = await runtime.receive({
      type: "input",
      viewId: first.viewId,
      input: { type: "view.toggle" },
    });
    const firstTraceId = latestTrace(firstResult.envelopes).trace.traceId;

    const secondResult = await runtime.receive({
      type: "input",
      viewId: second.viewId,
      input: { type: "view.toggle" },
    });

    const secondProjection = applyCounterPatch(
      second.projection,
      latestPatch(secondResult.envelopes),
    );
    expect(secondProjection.traceIds).not.toContain(firstTraceId);
  });

  test("trace store keeps dev-only events out of browser snapshots", () => {
    const traces = new TraceStore();
    const trace = traces.start("contract", { scopeId: "view-1" });

    traces.add(trace, "input", "browser event");
    traces.add(trace, "auth", "dev credential detail", { token: "secret" }, { visibility: "dev" });

    expect(traces.list("view-1")).toEqual([
      expect.objectContaining({
        events: [expect.objectContaining({ label: "browser event" })],
      }),
    ]);
    expect(traces.list("view-1", "dev")[0]?.events.map((event) => event.label)).toEqual([
      "browser event",
      "dev credential detail",
    ]);
  });

  test("external resource invalidation fans out patches to affected views", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const first = await connect(runtime);
    const second = await connect(runtime);

    services.counter.value = 7;
    const result = await runtime.invalidate([counterKey]);

    const patches = result.envelopes.filter(
      (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
    );

    expect(patches.map((patch) => patch.viewId).sort()).toEqual(
      [first.viewId, second.viewId].sort(),
    );
    expect(patches.map((patch) => applyCounterPatch(first.projection, patch).count)).toEqual([
      7, 7,
    ]);
    expect(result.envelopes.some((envelope) => envelope.type === "projection:update")).toBe(false);
  });

  test("action invalidation sends trace envelopes to every affected view", async () => {
    const services = createServices();
    const runtime = createCounterRuntime(services);
    const first = await connect(runtime);
    const second = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: first.viewId,
      input: { type: "action.increment", amount: 1 },
    });

    const secondPatch = result.envelopes.find(
      (envelope): envelope is ProjectionPatchEnvelope =>
        envelope.type === "projection:patch" && envelope.viewId === second.viewId,
    );
    const secondTrace = result.envelopes.find(
      (envelope): envelope is TraceEnvelope<TraceSnapshot> =>
        envelope.type === "trace:update" && envelope.viewId === second.viewId,
    );

    expect(secondPatch?.causedByTraceId).toBe(secondTrace?.trace.traceId);
  });

  test("unpatchable region values fall back to full projection updates", async () => {
    const services = createServices();
    const runtime = createUnpatchableRegionRuntime(services);
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.increment", amount: 1 },
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

  test("memory store can resume view state with a fresh runtime projection", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    await assertResumeRestoresView(store);
  });

  test("JSON file store can resume view state with a fresh runtime projection", async () => {
    const store = new JsonFileRuntimeStore<UIState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );
    await assertResumeRestoresView(store);
  });

  test("runtime stores expose envelope history after a cursor", async () => {
    const memory = new MemoryRuntimeStore<UIState, Projection>();
    const file = new JsonFileRuntimeStore<UIState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );

    await assertStoreEnvelopeHistory(memory);
    await assertStoreEnvelopeHistory(file);
  });

  test("runtime stores expose durability capability metadata", () => {
    const memory = new MemoryRuntimeStore<UIState, Projection>();
    const file = new JsonFileRuntimeStore<UIState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );

    expect(memory.capabilities).toMatchObject({
      ephemeral: true,
      singleProcess: true,
      singleWriter: true,
      supportsRangeRead: true,
      supportsObservationIndex: true,
      supportsAtomicCommit: true,
      supportsInputIdempotency: true,
    } satisfies Partial<RuntimeStoreCapabilities>);
    expect(file.capabilities).toMatchObject({
      ephemeral: false,
      singleProcess: true,
      singleWriter: true,
      supportsRangeRead: true,
      supportsObservationIndex: true,
      supportsAtomicCommit: true,
      supportsInputIdempotency: true,
    } satisfies Partial<RuntimeStoreCapabilities>);
  });

  test("runtime store commit assigns cursors checkpoints observations and input records atomically", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const checkpoint = createCheckpoint("view-commit", "scope-a", [counterRegion(1)]);

    const committed = await store.commitInvocation({
      envelopes: [
        {
          viewId: checkpoint.viewId,
          envelope: {
            type: "projection:update",
            viewId: checkpoint.viewId,
            cursor: "",
            projectionVersion: 1,
            projection: projectionFor(1),
            regions: [counterRegion(1)],
          },
        },
      ],
      views: [{ checkpoint, expectedRevision: 0 }],
      observations: [
        {
          fanoutScope: "scope-a",
          viewId: checkpoint.viewId,
          regions: [counterRegion(1)],
        },
      ],
      inputRecords: [
        {
          clientInputId: "input-commit",
          viewId: checkpoint.viewId,
          status: "committed",
        },
      ],
    });

    expect(committed.envelopes[0]?.cursor).toBe("cursor-1");
    expect(committed.views[0]).toMatchObject({
      viewId: checkpoint.viewId,
      cursor: "cursor-1",
      checkpointRevision: 1,
    });
    expect(await store.findViewsObserving("scope-a", [counterKey])).toEqual([
      {
        viewId: checkpoint.viewId,
        regions: [counterRegion(1)],
      },
    ]);
    expect(await store.readInputRecord("input-commit")).toEqual({
      clientInputId: "input-commit",
      viewId: checkpoint.viewId,
      status: "committed",
    });
  });

  test("observation index does not fan out across scopes", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();

    await store.replaceViewObservations({
      fanoutScope: "team-a",
      viewId: "view-a",
      regions: [counterRegion(1)],
    });
    await store.replaceViewObservations({
      fanoutScope: "team-b",
      viewId: "view-b",
      regions: [counterRegion(1)],
    });

    expect(await store.findViewsObserving("team-a", [counterKey])).toEqual([
      {
        viewId: "view-a",
        regions: [counterRegion(1)],
      },
    ]);
  });

  test("runtime stores list view checkpoints for stateless observation recovery", async () => {
    const memory = new MemoryRuntimeStore<UIState, Projection>();
    const file = new JsonFileRuntimeStore<UIState, Projection>(
      join(tmpdir(), `stupid-fp-framework-${crypto.randomUUID()}.json`),
    );

    await assertStoreListsViews(memory);
    await assertStoreListsViews(file);
  });

  test("JSON file store reports corrupted state as a typed store failure", async () => {
    const path = join(tmpdir(), `stupid-fp-framework-corrupt-${crypto.randomUUID()}.json`);
    await writeFile(path, "{ nope", "utf8");
    const store = new JsonFileRuntimeStore<UIState, Projection>(path);

    await expect(store.loadView("view-1")).rejects.toBeInstanceOf(RuntimeStoreError);
    await expect(store.loadView("view-1")).rejects.toMatchObject({
      type: "store-error",
      reason: "corrupt-store",
    });
  });

  test("resume with missed envelopes replays history instead of recomputing immediately", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connect(firstRuntime);

    const updated = await firstRuntime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });
    const earlierCursor = latestPatch(updated.envelopes).cursor;

    await firstRuntime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
      resume: {
        viewId: connected.viewId,
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
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connectWithEnvelope(firstRuntime);

    await firstRuntime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
      resume: {
        viewId: connected.viewId,
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

  test("resume with route mismatch creates a fresh view with an explicit rejection", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connect(firstRuntime);

    const updated = await firstRuntime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });
    const resumeCursor = latestTrace(updated.envelopes).cursor;

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/different/:id",
      params: { id: "main" },
      resume: {
        viewId: connected.viewId,
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

  test("resume with stale cursor restores view and refreshes projection", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const firstRuntime = createCounterRuntime(services, store);
    const connected = await connect(firstRuntime);

    await firstRuntime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });

    const resumedRuntime = createCounterRuntime(services, store);
    const resumed = await resumedRuntime.connect({
      type: "connect",
      route: "/contract/:id",
      params: { id: "main" },
      resume: {
        viewId: connected.viewId,
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

  test("stateless runtime can process a UI event in a fresh invocation", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const runtime = createStatelessRuntime(() => createCounterProgram(services), { store });
    const connected = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "view.toggle" },
    });

    const projection = applyCounterPatch(connected.projection, latestPatch(result.envelopes));

    expect(projection.selected).toBe(true);
    expect(latestTrace(result.envelopes).trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "ui",
          label: "view.toggle applied",
        }),
      ]),
    );
  });

  test("stateless runtime exposes traces without invoking the program factory", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    let createdPrograms = 0;
    const runtime = createStatelessRuntime(
      () => {
        createdPrograms += 1;
        return createCounterProgram(services);
      },
      { store },
    );

    expect(runtime.traces.list()).toEqual([]);
    expect(createdPrograms).toBe(0);

    await connect(runtime);

    expect(createdPrograms).toBe(1);
  });

  test("stateless action invalidation uses stored observations to fan out patches", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const runtime = createStatelessRuntime(() => createCounterProgram(services), { store });
    const first = await connect(runtime);
    const second = await connect(runtime);

    const result = await runtime.receive({
      type: "input",
      viewId: first.viewId,
      input: { type: "action.increment", amount: 3 },
    });
    const patches = result.envelopes.filter(
      (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
    );

    expect(patches.map((patch) => patch.viewId).sort()).toEqual(
      [first.viewId, second.viewId].sort(),
    );
    expect(patches.map((patch) => applyCounterPatch(first.projection, patch).count)).toEqual([
      3, 3,
    ]);
  });

  test("stateless resource events refresh checkpointed affected views", async () => {
    const store = new MemoryRuntimeStore<UIState, Projection>();
    const services = createServices();
    const runtime = createStatelessRuntime(() => createCounterProgram(services), { store });
    const first = await connect(runtime);
    const second = await connect(runtime);

    services.counter.value = 9;
    const result = await runtime.invalidate([counterKey]);
    const patches = result.envelopes.filter(
      (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
    );

    expect(patches.map((patch) => patch.viewId).sort()).toEqual(
      [first.viewId, second.viewId].sort(),
    );
    expect(patches.map((patch) => applyCounterPatch(first.projection, patch).count)).toEqual([
      9, 9,
    ]);
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

  test("stream parser rejects input payloads without a string type", () => {
    expect(
      parseClientEnvelope(
        JSON.stringify({
          type: "input",
          viewId: "view-1",
          input: { payload: true },
        }),
      ),
    ).toMatchObject({ type: "error", message: "Invalid input envelope" });
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
  store?: RuntimeStore<UIState, Projection>,
  plugins: FrameworkPlugin<TestEnvironment>[] = [],
) {
  return createRuntime(createCounterProgram(services, plugins), { store });
}

function createCounterProgram(
  services = createServices(),
  plugins: FrameworkPlugin<TestEnvironment>[] = [],
) {
  return defineProgram<TestEnvironment, UIState, UIEvent, ActionInput, Projection>({
    layer: createServicesLayer(services),
    plugins,
    resources: [
      defineResource<TestEnvironment, number>("Counter", () =>
        Effect.map(CounterService, (counter) => counter.value),
      ),
    ],
    uiState: counterUIState,
    screen: {
      route: counterRoute,
      project: (view, context) =>
        Effect.gen(function* () {
          return {
            route: view.route,
            params: view.params,
            selected: yield* context.region("selected", () => Effect.succeed(view.ui.selected)),
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
        .run<{ count: number }, TestEnvironment>((input, context) =>
          Effect.gen(function* () {
            const counter = yield* CounterService;
            counter.value += input.amount;
            counter.writes.push(`increment:${input.amount}`);
            context.invalidate(counterKey);
            return { count: counter.value };
          }),
        ),
      Action.define("action.fail")
        .input(failSchema)
        .run(() => Effect.fail(actionFailure("contract failure"))),
    ],
  });
}

function createUnpatchableRegionRuntime(
  services = createServices(),
  store?: RuntimeStore<UIState, Projection>,
) {
  const program = defineProgram<TestEnvironment, UIState, UIEvent, ActionInput, Projection>({
    layer: createServicesLayer(services),
    resources: [
      defineResource<TestEnvironment, number>("Counter", () =>
        Effect.map(CounterService, (counter) => counter.value),
      ),
    ],
    uiState: UIState.define<UIState, UIEvent>({
      init: () => ({ selected: false }),
      events: [
        {
          type: "view.toggle",
          schema: toggleSchema,
          update: (state) => state,
        },
      ],
    }),
    screen: {
      route: "/contract",
      project: (view, context) =>
        Effect.gen(function* () {
          const counter = yield* context.region("counter", () =>
            Effect.map(context.resources.read(counterKey), (count) => ({
              count,
              unpatchable: () => undefined,
            })),
          );

          return {
            route: view.route,
            params: view.params,
            selected: view.ui.selected,
            count: counter.count,
            traceIds: [],
          };
        }),
    },
    actions: [
      Action.define("action.increment")
        .input(incrementSchema)
        .run<{ count: number }, TestEnvironment>((input, context) =>
          Effect.gen(function* () {
            const counter = yield* CounterService;
            counter.value += input.amount;
            context.invalidate(counterKey);
            return { count: counter.value };
          }),
        ),
    ],
  });

  return createRuntime(program, { store });
}

function createFailingProjectionRuntime() {
  const program = defineProgram<TestEnvironment, UIState, UIEvent, ActionInput, Projection>({
    layer: createServicesLayer(createServices()),
    resources: [],
    uiState: UIState.define<UIState, UIEvent>({
      init: () => ({ selected: false }),
      events: [
        {
          type: "view.toggle",
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
  const program = defineProgram<TestEnvironment, UIState, UIEvent, ActionInput, Projection>({
    layer: createServicesLayer(createServices()),
    resources: [
      defineResource<TestEnvironment, number>("Counter", () =>
        Effect.map(CounterService, (counter) => counter.value),
      ),
    ],
    uiState: UIState.define<UIState, UIEvent>({
      init: () => ({ selected: false }),
      events: [
        {
          type: "view.toggle",
          schema: toggleSchema,
          update: (state) => state,
        },
      ],
    }),
    screens: [
      {
        route: "/first",
        project: (view, context) =>
          Effect.map(context.resources.read(counterKey), (count) => ({
            route: view.route,
            params: view.params,
            selected: view.ui.selected,
            count,
            traceIds: [],
          })),
      },
      {
        route: "/second",
        project: (view, context) =>
          Effect.map(context.resources.read(counterKey), (count) => ({
            route: view.route,
            params: view.params,
            selected: view.ui.selected,
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

  return { viewId: connected.viewId, projection: connected.projectionEnvelope.projection };
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

  return { viewId: connected.viewId, projectionEnvelope: projection };
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

async function assertResumeRestoresView(store: RuntimeStore<UIState, Projection>) {
  const services = createServices();
  const firstRuntime = createCounterRuntime(services, store);
  const connected = await connect(firstRuntime);

  const updated = await firstRuntime.receive({
    type: "input",
    viewId: connected.viewId,
    input: { type: "view.toggle" },
  });
  const resumeCursor = latestTrace(updated.envelopes).cursor;

  const resumedRuntime = createCounterRuntime(services, store);
  const resumed = await resumedRuntime.connect({
    type: "connect",
    route: "/contract/:id",
    params: { id: "main" },
    resume: {
      viewId: connected.viewId,
      cursor: resumeCursor,
    },
  });

  expect(resumed.envelopes[0]).toMatchObject({
    type: "connected",
    viewId: connected.viewId,
    resumed: true,
    resume: { status: "refreshed", reason: "current-cursor" },
  });
  expect(latestProjection(resumed.envelopes).projection.selected).toBe(true);
}

async function assertStoreEnvelopeHistory(store: RuntimeStore<UIState, Projection>) {
  const firstCursor = await store.nextCursor();
  await store.appendEnvelope("view-x", firstCursor, {
    type: "connected",
    viewId: "view-x",
    cursor: firstCursor,
    resumed: false,
    resume: { status: "fresh" },
  });

  const secondCursor = await store.nextCursor();
  await store.appendEnvelope("view-x", secondCursor, {
    type: "projection:update",
    viewId: "view-x",
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

  expect(await store.readEnvelopesAfter("view-x", firstCursor)).toMatchObject([
    {
      viewId: "view-x",
      cursor: secondCursor,
      envelope: { type: "projection:update" },
    },
  ]);
}

async function assertStoreListsViews(store: RuntimeStore<UIState, Projection>) {
  const checkpoint: ViewCheckpoint<UIState> = {
    checkpointVersion: 1,
    viewId: "view-for-store-contract",
    route: "/contract/:id",
    params: { id: "main" },
    fanoutScope: "global",
    ui: { selected: true },
    projectionVersion: 1,
    checkpointRevision: 0,
    cursor: "cursor-for-store-contract",
    observedRegions: [],
  };

  await store.saveView(checkpoint);

  expect(await store.listViews()).toEqual([
    expect.objectContaining({
      viewId: checkpoint.viewId,
      ui: { selected: true },
    }),
  ]);
}

function createCheckpoint(
  viewId: string,
  fanoutScope: string,
  observedRegions = [] as ViewCheckpoint<UIState>["observedRegions"],
): ViewCheckpoint<UIState> {
  return {
    checkpointVersion: 1,
    viewId,
    route: "/contract/:id",
    params: { id: "main" },
    fanoutScope,
    ui: { selected: false },
    projectionVersion: 1,
    checkpointRevision: 0,
    cursor: null,
    observedRegions,
  };
}

function counterRegion(value: number): ViewCheckpoint<UIState>["observedRegions"][number] {
  return {
    id: "counter",
    value,
    resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
  };
}

function projectionFor(count: number): Projection {
  return {
    route: "/contract/:id",
    params: { id: "main" },
    selected: false,
    count,
    traceIds: [],
  };
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
