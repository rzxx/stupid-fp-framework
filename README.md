# stupid-fp-framework

**Build workflow-heavy webapps as durable server programs with live projections and causal traces.**

[![Status](https://img.shields.io/badge/status-experimental-orange)]()

> Work-in-progress. Ideas may explode. [Read the docs →](docs/design.md)

---

## what if.

Every workflow app starts simple and grows into a tangle of fetch calls, loading states, cache
invalidation, background-job polling, WebSocket glue, audit logs, and two codebases that need to
stay in sync.

What if instead you wrote **one durable server program** and the browser rendered its live
projection?

```
typed input -> transaction -> resource invalidation
-> projection recomputation -> streamed patch/update -> causal trace
```

You write the program once. The runtime handles invalidation, projection, streaming, and tracing automatically.

---

## this is

- **Promise-first by default** — author resources and actions with `async/await`
- **Effect-native when you want it** — bring Effect knowledge for typed capabilities, dependency injection, and testable server logic
- **Resource-driven** — define your data as resources, and the runtime automatically tracks who reads what
- **Program-owned state** — durable workflow truth stays in resources/actions; server-observed view/editing context is modeled as `UIState`
- **Reactive by default** — actions invalidate resources, runtime pushes patches to all affected clients
- **Typed program inputs** — actions, UI events, resource events, and system events have distinct jobs
- **Trace-first** — program inputs explain validation, auth, effects, invalidation, recomputation, and streamed patches
- **Modular by design** — adopt traces, resource tracking, or stores individually before buying the full runtime

## this is not

- ❌ A React meta-framework (it's not Next.js, Remix, or similar)
- ❌ A request/response API framework (you don't write app-state endpoints — you write a program)
- ❌ A replacement for everything (SSR, SEO, static sites — see what it is above)
- ❌ Production-ready (see status below)

---

## where this fits

**Sweet spot:** workflow-heavy tools where the UI is a live projection of server state. Approval flows, incident consoles, operations dashboards, moderation queues, admin panels with live actions. Apps that need permissions, audit trails, long-running work, and the ability to answer "why did this change?"

**Not the fit:** marketing sites, content pages, simple CRUD, or apps where request/response plus client caching is enough. If your UI doesn't react to server-side workflow changes, this is overkill.

**How it differs:** instead of designing endpoints, managing client caches, and wiring invalidation by hand, you write one server program. The runtime tracks what each view reads, pushes patches when resources change, and records causal traces for every update. React stays your rendering layer — components, ecosystem, and local state all work as usual.

---

## the idea in 30 seconds

You define three things:

1. **Resources** — the data your app cares about (e.g., `PendingDeployments`, `Deployment`, `AuditTrail`)
2. **Actions** — things users can do (e.g., `approveDeployment`), with validation and effects
3. **UI state + screens** — how view/editing state combines with resources into UI data, grouped into named `region`s

The runtime wires them together. When an action runs, it invalidates resources. When a UI event
runs, it updates server-observed view context without mutating domain truth. The runtime figures out
which views are affected, recomputes their projections, and pushes UI patches over WebSocket. React
renders the projection and may keep renderer-owned state that the program cannot observe.

```ts
// A resource — typed key + Promise loader
const PendingDeployments = Resource.define("PendingDeployments")
  .value<Deployment[]>()
  .key(Schema.Struct({ teamId: Schema.String }), {
    id: (params) => params.teamId,
  })
  .load(async (params) => {
    const deployments = await getDeployments();
    return deployments.pending(params.teamId);
  });

// An action — schema-backed input + Promise transaction
const approveDeployment = Action.define("action.approveDeployment")
  .input(
    Schema.Struct({
      type: Schema.Literal("action.approveDeployment"),
      deploymentId: Schema.String,
    }),
  )
  .run(async (msg, ctx) => {
    const deployment = await deployments.approve(msg.deploymentId);
    ctx.invalidate(PendingDeployments.key({ teamId: deployment.teamId }));
    ctx.invalidate(Deployment.key({ deploymentId: msg.deploymentId }));
  });

// UI state — view/editing context, not durable workflow truth
const approvalUI = UIState.define("approval.ui")
  .init(() => ({ selectedDeploymentId: null }))
  .event(
    "ui.deployment.select",
    Schema.Struct({
      type: Schema.Literal("ui.deployment.select"),
      deploymentId: Schema.String,
    }),
    (ui, event) => ({ ...ui, selectedDeploymentId: event.deploymentId }),
  )
  .build();

// A screen — reads resources in named regions
const screen = Screen.define("approval.deployments")
  .route("/teams/:teamId/deployments", {
    params: Schema.Struct({ teamId: Schema.String }),
  })
  .regions({
    layout: Region.merge(),
    pendingDeployments: Region.replace(),
  })
  .project(async (view, ctx) => ({
    pending: await ctx.region("pendingDeployments", async () =>
      ctx.read(PendingDeployments.key({ teamId: view.params.teamId })),
    ),
  }));

const program = Program.define("approval")
  .resources(PendingDeployments, Deployment)
  .ui(approvalUI)
  .screens(screen)
  .actions(approveDeployment)
  .build();
```

### Effect-native authoring (advanced)

When you need typed effects, capability injection, or testable server logic, switch to Effect:

```ts
class Deployments extends Context.Tag("Deployments")<
  Deployments,
  {
    pending: (teamId: string) => Deployment[];
    approve: (deploymentId: string) => Deployment;
  }
>() {}

const PendingDeployments = Resource.define("PendingDeployments")
  .value<Deployment[]>()
  .key(Schema.Struct({ teamId: Schema.String }), {
    id: (params) => params.teamId,
  })
  .loadEffect((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pending(params.teamId);
    }),
  );

const approveDeployment = Action.define("action.approveDeployment")
  .input(
    Schema.Struct({
      type: Schema.Literal("action.approveDeployment"),
      deploymentId: Schema.String,
    }),
  )
  .runEffect((msg, ctx) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      const deployment = yield* Effect.sync(() => deployments.approve(msg.deploymentId));
      ctx.invalidate(PendingDeployments.key({ teamId: deployment.teamId }));
      ctx.invalidate(Deployment.key({ deploymentId: msg.deploymentId }));
    }),
  );
```

### State ownership

Every piece of state falls into one bucket:

- **Program-owned** — domain truth (resources/actions) and server-observed view context (`UIState`). Use when it affects projection, resume, auth, sharing, or traces.
- **Renderer-owned** — focus, hover, measurement, animation, uncontrolled inputs. Must be disposable.
- **Protocol state** — optimistic overlays, pending IDs, cursors, reconnect. Adapter/runtime machinery, not app truth.

Optimistic UI is a temporary projection overlay tied to a typed input, confirmed or rolled back by the server.

```ts
stream.actions.run(
  { type: "action.approveDeployment", deploymentId },
  { optimistic: markDeploymentApproving(deploymentId), settle: "projection" },
);
```

See [Model & Vocabulary](docs/design/model.md#state-ownership) for the full ownership rules.

---

## quickstart

```sh
git clone <this-repo>
cd stupid-fp-framework
bun install
bun run dev
```

Opens on `http://localhost:3000` with the Deployment Approval demo — a live app where you can select deployments, approve them, and watch the causality traces update in real time.

Vite is the framework host. The app is configured through `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { stupidFp } from "./src/vite";

export default defineConfig({
  plugins: [
    stupidFp({
      template: "src/index.html",
      client: "src/demo/approvals/client/app.tsx",
      server: "src/demo/approvals/server.ts",
      reactCompiler: true,
    }),
  ],
});
```

```sh
bun run dev       # starts Vite as the app host
bun run build     # runs Vite's app build for client and server outputs
bun run test      # runs the Vitest contract + integration + acceptance tests
bun run typecheck # tsc --noEmit
bun run check     # typecheck + lint + format check
```

---

## adoption ladder

You do not have to adopt the whole server-program model first. The package exposes opt-in
entrypoints for smaller experiments:

```ts
import { TraceStore } from "stupid-fp-framework/trace";
import { Resource, ResourceGraph } from "stupid-fp-framework/resource";
import { MemoryRuntimeStore } from "stupid-fp-framework/store";
import { Schema } from "stupid-fp-framework/effect";
```

Start small and climb:

1. **Traces only** — use `TraceStore` to record browser-safe causal events
2. **Resource tracking** — use `ResourceGraph` to track which named regions read which resources
3. **Runtime stores** — experiment with checkpoints, cursors, envelopes, and observation indexes
4. **Promise-first resources, actions, and screens** — author with `async/await` via `load`, `run`, and `project`
5. **Stream/patch + React/Vite adapters** — add live transport, rendering, and the Vite host when useful
6. **Full durable program** — buy the whole model when you're ready

```ts
// Promise-first: no Effect required
const Counter = Resource.define("Counter")
  .value<number>()
  .key<{ id: string }>(Schema.Struct({ id: Schema.String }), {
    id: (params) => params.id,
  })
  .load(async (params) => params.id.length);

const graph = new ResourceGraph();
graph.register(Counter);

const observed = await graph.observe(() =>
  graph.regionAsync("counter", () => graph.readAsync(Counter.key({ id: "main" }))),
);
```

Add Effect-native authoring (`stupid-fp-framework/effect`) when you need typed capabilities,
dependency injection, or advanced error handling.

---

## project status

This is v0.0.0. It's a working prototype that passes its contract, integration, and acceptance tests. But it's:

- Not optimized for production
- Runtime stores are contract-tested development adapters, not production durability adapters yet
- Not packaged for npm
- Not API-stable (everything can change)
- **Real enough to explore the idea** — run the demo, read the source, see if the paradigm clicks

The best way to use this right now is as a **learning tool** and a **conversation starter**. If the "one program" model resonates with you, this is a place to play with it.

---

## docs

- **[Design Overview](docs/design.md)** — start here for the full picture
- **[Model & Vocabulary](docs/design/model.md)** — core concepts: resources, actions, UI state, view checkpoints, projections, regions
- **[Developer Experience](docs/design/developer-experience.md)** — what it feels like to write an app
- **[Runtime Architecture](docs/design/runtime.md)** — how connect, receive, project, and invalidation work
- **[Proposal](docs/proposal.md)** — the original pitch
- **[Experiments & Open Questions](docs/design/experiments.md)** — what's still being figured out
- **[Stage 8 Record](docs/stage-8-record.md)** — current invocation, recovery, and adapter contract implementation record
- **[Stage 9 Record](docs/stage-9-record.md)** — implementation record for patch manifests, navigation, and builder APIs
- **[Framework State Review 7](docs/framework-state-review-7.md)** — Stage 10 semantic hardening for state ownership, resource scopes, and trace-first positioning
- **[Framework State Review 8](docs/framework-state-review-8.md)** — modular adoption direction for subpath exports and Promise-first APIs

---

## philosophy

This project is "stupid" in the sense that it challenges the complexity we've accepted as normal.

The modern workflow stack demands you think about: client state, server state, cache invalidation,
API design, loading states, optimistic updates, revalidation, stale-while-revalidate, suspense
boundaries, error boundaries, request waterfalls, background jobs, audit logs, and "why did this
happen?" debugging.

What if instead you just didn't?

What if writing a workflow app felt like writing a **durable server program** — one that happens to
project a live UI into a browser?

That's the bet. It might be wrong. But it's the reason this repo exists.

---

## built with

- **[Effect](https://effect.website)** — typed effects for advanced server logic (optional)
- **[Vite](https://vite.dev)** — canonical host pipeline for client modules, CSS, React Refresh, SSR transforms, app builds, dev middleware, env, and production assets
- **[Node.js](https://nodejs.org)** — default server runtime target
- **[Bun](https://bun.sh)** — package manager used by this repo; runtime support is adapter-shaped, not the framework core
- **[React 19](https://react.dev)** — UI rendering layer with adapter-owned root, provider, optimistic, and error-boundary conventions

---

## license

MIT
