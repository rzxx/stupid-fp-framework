import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { Action, createRuntime, Program, Screen, UIState } from "stupid-fp-framework/runtime";
import { Schema } from "stupid-fp-framework/effect";
import { Resource, ResourceGraph } from "stupid-fp-framework/resource";
import { MemoryRuntimeStore } from "stupid-fp-framework/store";
import type { ProjectionPatchEnvelope, ServerEnvelope } from "stupid-fp-framework/stream";
import { TraceStore, type TraceSnapshot } from "stupid-fp-framework/trace";
import { applyRegionValuePatchAutomatically } from "stupid-fp-framework/patch";
import type { ProgramStreamReactOptions } from "stupid-fp-framework/react";
import { serveViteProgram } from "stupid-fp-framework/vite";

describe("modular adoption surface", () => {
  test("public subpath exports are importable without the full framework barrel", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    const traces = new TraceStore();
    const graph = new ResourceGraph();
    const store = new MemoryRuntimeStore<Record<string, never>, Record<string, never>>();
    const reactOptions = null as ProgramStreamReactOptions<unknown, { traceId: string }> | null;

    expect(traces.list()).toEqual([]);
    expect(graph).toBeInstanceOf(ResourceGraph);
    expect(store.capabilities.supportsObservationIndex).toBe(true);
    expect(applyRegionValuePatchAutomatically({ count: 0 }, patchEnvelope(1))).toEqual({
      count: 1,
    });
    expect(reactOptions).toBeNull();
    expect(typeof serveViteProgram).toBe("function");
    expect(packageJson.exports["./vite"]).toBe("./src/vite.ts");
    expect(packageJson.exports["./bun"]).toBeUndefined();
  });

  test("trace can be used standalone with browser-safe snapshots", () => {
    const traces = new TraceStore();
    const trace = traces.start("standalone trace");

    traces.add(trace, "input", "public event");
    traces.add(trace, "effect", "private event", undefined, { visibility: "dev" });
    traces.complete(trace);

    expect(traces.snapshot(trace, "browser").events.map((event) => event.label)).toEqual([
      "public event",
    ]);
    expect(traces.snapshot(trace, "dev").events.map((event) => event.label)).toEqual([
      "public event",
      "private event",
    ]);
  });

  test("resources can track observed regions with Promise loaders outside Program", async () => {
    const graph = new ResourceGraph();
    const Counter = Resource.define("StandaloneCounter")
      .value<number>()
      .key<{ id: string }>(Schema.Struct({ id: Schema.String }), {
        id: (params) => params.id,
      })
      .load((params) => Promise.resolve(params.id.length));

    graph.register(Counter);

    const observed = await graph.observe(() =>
      graph.regionAsync("counter", () => graph.readAsync(Counter.key({ id: "main" }))),
    );

    expect(observed.value).toBe(4);
    expect(observed.regions).toEqual([
      {
        id: "counter",
        value: 4,
        resources: [
          {
            type: "StandaloneCounter",
            id: "main",
            label: "StandaloneCounter(main)",
          },
        ],
      },
    ]);
  });

  test("runtime stores can be used directly for checkpoints envelopes and observations", async () => {
    type UI = { open: boolean };
    type Projection = { count: number };

    const store = new MemoryRuntimeStore<UI, Projection>();
    const connected: ServerEnvelope<Projection, TraceSnapshot> = {
      type: "connected",
      viewId: "view-standalone",
      cursor: "",
      resumed: false,
      resume: { status: "fresh" },
    };

    await store.commitInvocation({
      envelopes: [{ viewId: "view-standalone", envelope: connected }],
      views: [
        {
          checkpoint: {
            checkpointVersion: 1,
            viewId: "view-standalone",
            route: "/standalone",
            params: {},
            fanoutScope: "team-a",
            ui: { open: true },
            projectionVersion: 1,
            checkpointRevision: 0,
            cursor: null,
            observedRegions: [],
          },
        },
      ],
      observations: [
        {
          fanoutScope: "team-a",
          viewId: "view-standalone",
          regions: [
            {
              id: "count",
              value: 1,
              resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
            },
          ],
        },
      ],
    });

    expect(await store.loadView("view-standalone")).toMatchObject({
      ui: { open: true },
      cursor: "cursor-1",
    });
    expect(await store.readEnvelopesAfter("view-standalone", "cursor-0")).toEqual([]);
    expect(
      await store.findViewsObservingResources([
        { type: "Counter", id: "main", label: "Counter(main)" },
      ]),
    ).toEqual([
      {
        viewId: "view-standalone",
        regions: [
          {
            id: "count",
            value: 1,
            resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
          },
        ],
      },
    ]);
  });

  test("Promise resource loaders and async actions run through the full runtime", async () => {
    type UI = Record<string, never>;
    type UIEvent = { type: "ui.noop" };
    type Input = { type: "action.increment"; amount: number } | { type: "action.fail" };
    type Projection = { count: number };

    let count = 0;
    const Count = Resource.define("AsyncCount")
      .value<number>()
      .key<{ id: string }>(Schema.Struct({ id: Schema.String }), {
        id: (params) => params.id,
      })
      .load(() => count);
    const countKey = Count.key({ id: "main" });
    const program = Program.define("async-api")
      .resources(Count)
      .ui<UI, UIEvent>(UIState.define<UI, UIEvent>({ init: () => ({}), events: [] }))
      .screens<Projection>(
        Screen.define("async.counter")
          .route("/async", { params: Schema.Struct({}) })
          .project(async (_view, context) => ({
            count: await context.region("count", () => context.read(countKey)),
          })),
      )
      .actions<Input>(
        Action.define("action.increment")
          .input<Extract<Input, { type: "action.increment" }>>(
            Schema.Struct({ type: Schema.Literal("action.increment"), amount: Schema.Number }),
          )
          .run<{ count: number }>(async (input, context) => {
            count += input.amount;
            context.invalidate(countKey);
            return { count };
          }),
        Action.define("action.fail")
          .input<Extract<Input, { type: "action.fail" }>>(
            Schema.Struct({ type: Schema.Literal("action.fail") }),
          )
          .run(() => Action.reject("async rejected")),
      )
      .build();
    const runtime = createRuntime(program);
    const connected = await runtime.connect({ type: "connect", route: "/async", params: {} });
    const viewId = connected.envelopes.find((envelope) => envelope.type === "connected")?.viewId;

    if (!viewId) {
      throw new Error("Expected connected view");
    }

    const updated = await runtime.receive({
      type: "input",
      viewId,
      input: { type: "action.increment", amount: 2 },
    });
    const patch = updated.envelopes.find((envelope) => envelope.type === "projection:patch");

    if (!patch) {
      throw new Error("Expected projection patch");
    }

    expect(applyRegionValuePatchAutomatically({ count: 0 }, patch)).toEqual({ count: 2 });

    const failed = await runtime.receive({
      type: "input",
      viewId,
      input: { type: "action.fail" },
    });
    const result = failed.envelopes.find((envelope) => envelope.type === "action:result");

    expect(result).toMatchObject({ ok: false, error: "async rejected" });
  });

  test("React adapters do not import the full framework barrel", () => {
    for (const file of sourceFiles(join(import.meta.dir, "..", "src", "adapters", "react"))) {
      const content = readFileSync(file, "utf8");

      expect(content).not.toContain('from "../../framework"');
      expect(content).not.toContain('from "../../../framework"');
    }
  });

  test("public core framework modules have no dependency cycles", () => {
    expect(findCycles(join(import.meta.dir, "..", "src", "framework"))).toEqual([]);
  });
});

function patchEnvelope(count: number): ProjectionPatchEnvelope {
  return {
    type: "projection:patch",
    viewId: "view-1",
    cursor: "cursor-1",
    projectionVersion: 1,
    patch: {
      kind: "region-values",
      regions: [{ id: "count", value: count, resources: [] }],
    },
  };
}

function sourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return /\.[cm]?[tj]sx?$/.test(entry.name) ? [path] : [];
  });
}

function findCycles(root: string): string[][] {
  const files = sourceFiles(root);
  const modules = new Set(
    files.map((file) => moduleName(root, file)).filter((module) => module !== "index"),
  );
  const graph = new Map([...modules].map((module) => [module, [] as string[]]));

  for (const file of files) {
    const module = moduleName(root, file);

    if (!graph.has(module)) {
      continue;
    }

    const content = readFileSync(file, "utf8");

    for (const match of content.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];

      if (!specifier.startsWith(".")) {
        continue;
      }

      const dependency = resolveLocalModule(root, file, specifier);

      if (dependency && graph.has(dependency)) {
        graph.get(module)?.push(dependency);
      }
    }
  }

  return stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1)
    .map((component) => component.sort());
}

function moduleName(root: string, file: string): string {
  return relative(root, file)
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[tj]sx?$/, "");
}

function resolveLocalModule(root: string, from: string, specifier: string): string | null {
  const base = normalize(join(from, "..", specifier));
  const candidates = [".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => `${base}${suffix}`);
  const found = candidates.find((candidate) => sourceExists(candidate));

  return found ? moduleName(root, found) : null;
}

function sourceExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const components: string[][] = [];

  for (const vertex of graph.keys()) {
    if (!indexes.has(vertex)) {
      visit(vertex);
    }
  }

  return components;

  function visit(vertex: string): void {
    indexes.set(vertex, nextIndex);
    lowlinks.set(vertex, nextIndex);
    nextIndex += 1;
    stack.push(vertex);
    onStack.add(vertex);

    for (const dependency of graph.get(vertex) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowlinks.set(vertex, Math.min(lowlinks.get(vertex) ?? 0, lowlinks.get(dependency) ?? 0));
      } else if (onStack.has(dependency)) {
        lowlinks.set(vertex, Math.min(lowlinks.get(vertex) ?? 0, indexes.get(dependency) ?? 0));
      }
    }

    if (lowlinks.get(vertex) !== indexes.get(vertex)) {
      return;
    }

    const component: string[] = [];
    let current: string | undefined;

    do {
      current = stack.pop();

      if (!current) {
        break;
      }

      onStack.delete(current);
      component.push(current);
    } while (current !== vertex);

    components.push(component);
  }
}
