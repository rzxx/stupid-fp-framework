# stupid-fp-framework

**Build webapps as durable server programs, not client/server glue.**

[![Status](https://img.shields.io/badge/status-experimental-orange)]()

> Work-in-progress. Ideas may explode. [Read the docs →](docs/design.md)

---

## what if.

Every webapp starts simple and grows into a tangle of fetch calls, loading states, cache invalidation, and two codebases that need to stay in sync.

What if instead you wrote **one program** — a server program — and the UI was just a projection of its state?

```
browser event → typed program input → server runs effect → resources update
→ runtime figures out what changed → streams UI patch → React renders it
```

No API layer. No client-side cache soup. No manual sync. Domain state lives in the server program; UI state is explicit view/editing context; React renders the projection. Optimistic UI is a temporary projection overlay tied to typed inputs and server traces, not another source of truth.

---

## this is

- A **Bun-native** framework (no webpack, no vite by default — just `bun --hot`)
- **Effect-powered** backend — typed, composable, testable server logic
- **Resource-driven** — define your data as resources, and the runtime automatically tracks who reads what
- **Domain + UI state** — durable workflow truth stays in resources/actions; transient view/editing context is modeled as UI state
- **Stateless-capable runtime** — view checkpoints and stream history can be restored from runtime stores instead of process memory
- **Reactive by default** — actions invalidate resources, runtime pushes patches to all affected clients
- **Typed program inputs** — actions, UI events, resource events, and system events have distinct jobs
- **Causally traced** — program inputs leave traces; debugging is actually pleasant

## this is not

- ❌ A React meta-framework (it's not Next.js, Remix, or similar)
- ❌ An API framework (you don't write endpoints — you write a program)
- ❌ A replacement for everything (SSR, SEO, static sites — see what it is above)
- ❌ Production-ready (see status below)

---

## the idea in 30 seconds

You define three things:

1. **Resources** — the data your app cares about (e.g., `PendingDeployments`, `Deployment`, `AuditTrail`)
2. **Actions** — things users can do (e.g., `approveDeployment`), with validation, auth, and effects
3. **UI state + screens** — how view/editing state combines with resources into UI data, grouped into named `region`s

The runtime wires them together. When an action runs, it invalidates resources. When a UI event runs, it updates UI state without mutating domain truth. The runtime figures out which views are affected, recomputes their projections, and pushes UI patches over WebSocket. React just renders.

```ts
class Deployments extends Context.Tag("Deployments")<
  Deployments,
  {
    pending: (teamId: string) => Deployment[];
    approve: (deploymentId: string) => Deployment;
  }
>() {}

// A resource — typed key + Effect-native loader
const PendingDeployments = Resource.define("PendingDeployments")
  .value<Deployment[]>()
  .key(Schema.Struct({ teamId: Schema.String }), {
    id: (params) => params.teamId,
  })
  .load((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pending(params.teamId);
    }),
  );

// An action — schema-backed input + Effect transaction
const approveDeployment = Action.define("action.approveDeployment")
  .input(
    Schema.Struct({
      type: Schema.Literal("action.approveDeployment"),
      deploymentId: Schema.String,
    }),
  )
  .run((msg, ctx) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      const deployment = yield* Effect.sync(() => deployments.approve(msg.deploymentId));
      ctx.invalidate(PendingDeployments.key({ teamId: deployment.teamId }));
      ctx.invalidate(Deployment.key({ deploymentId: msg.deploymentId }));
    }),
  );

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
  .patchManifest(approvalProjectionPatchManifest)
  .project((view, ctx) =>
    Effect.gen(function* () {
      return {
        pending: yield* ctx.region("pendingDeployments", () =>
          ctx.resources.read(PendingDeployments.key({ teamId: view.params.teamId })),
        ),
      };
    }),
  );

const program = Program.define("approval")
  .resources(PendingDeployments, Deployment)
  .ui(approvalUI)
  .screens(screen)
  .actions(approveDeployment)
  .build();
```

Application state has two public homes. If losing it corrupts workflow truth, model it as domain
state through resources and actions. If it is view or editing context, model it as `UIState`.
React state is only for adapter and render mechanics the program should not observe, such as focus,
measurement, pointer position, animation phase, or third-party widget internals.

Optimistic UI belongs to the input pipeline. The React adapter can apply a temporary projection
overlay when a UI event or action is sent, then confirm or roll it back when the server projection,
action result, or trace arrives.

```ts
stream.ui.send(
  { type: "ui.deployment.filter", value },
  {
    optimistic: (projection) => ({ ...projection, deploymentFilter: value }),
  },
);

stream.actions.run(
  { type: "action.approveDeployment", deploymentId },
  {
    optimistic: markDeploymentApproving(deploymentId),
    settle: "projection",
  },
);
```

---

## quickstart

```sh
git clone <this-repo>
cd stupid-fp-framework
bun install
bun dev
```

Opens on `http://localhost:3000` with the Deployment Approval demo — a live app where you can select deployments, approve them, and watch the causality traces update in real time.

```sh
bun test          # runs the contract + integration + acceptance tests
bun typecheck     # tsc --noEmit
bun check         # typecheck + lint + format check
```

---

## project status

This is v0.0.0. It's a working prototype that passes its contract, integration, and acceptance tests. But it's:

- Not optimized for production
- Runtime stores are contract-tested development adapters, not production durability adapters yet
- Stateless invocation is present but still early; Bun remains the main demo host
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
- **[Framework State Review 6](docs/framework-state-review-6.md)** — current patch, routing, dev server, and API direction
- **[Stage 9 Record](docs/stage-9-record.md)** — implementation record for patch manifests, navigation, Bun assets, and builder APIs

---

## philosophy

This project is "stupid" in the sense that it challenges the complexity we've accepted as normal.

The modern webapp stack demands you think about: client state, server state, cache invalidation, API design, loading states, optimistic updates, revalidation, stale-while-revalidate, suspense boundaries, error boundaries, request waterfalls...

What if instead you just didn't?

What if writing a webapp felt like writing a **single program** — one that happens to render a UI in a browser?

That's the bet. It might be wrong. But it's the reason this repo exists.

---

## built with

- **[Bun](https://bun.sh)** — runtime, bundler, test runner, package manager
- **[Effect](https://effect.website)** — typed effects for server logic
- **[React 19](https://react.dev)** — UI rendering layer

---

## license

MIT
