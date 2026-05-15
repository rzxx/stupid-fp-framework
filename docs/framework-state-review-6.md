# Framework State Review 6

## Purpose

This report audits the framework after Stage 8 from the perspective of developer-facing coherence.
It is a design review, not an implementation patch. Stage 8 made the runtime claims more honest
through invocation context, scoped observation indexing, reconnecting streams, input IDs, patch
manifests, and Bun dev reload. Review 6 asks the next question:

```txt
What is the framework's latest best path for patches, routing/layouts, Bun-native development,
and public API syntax?
```

The answer is that the core model is still strong, but the public surface now exposes several
prototype layers at once. The next work should make those layers feel like one framework.

Sources reviewed:

- `README.md`
- `docs/design/model.md`
- `docs/design/runtime.md`
- `docs/design/developer-experience.md`
- `docs/design/experiments.md`
- `docs/framework-state-review-4.md`
- `docs/framework-state-review-5.md`
- `docs/stage-7-record.md`
- `docs/stage-8-record.md`
- `src/framework/*`
- `src/adapters/react/*`
- `src/demo/approvals/*`
- `tests/*`

## Current Verification State

Before this report was added:

- `git status --short` was clean.
- `bun test`: 57 tests pass.
- `bun run check`: typecheck, lint, and format check pass.

## Executive Summary

The latest implemented path is:

```txt
Domain resources
+ Actions
+ UIState/UIEvents
+ Screen projections with named regions
+ Runtime observation index
+ region-value projection patches
+ React stream adapter
+ Bun host with dev reload
```

That is a coherent architecture. The confusion is not that the system is incoherent underneath. The
confusion is that the public story still looks like several experiments at once:

- Patch protocol is real, but its ownership and manifest story are underexplained.
- Routing exists for screen selection, but not yet for real URL navigation or layouts.
- Bun-native development is intentionally canonical, but asset processing and reload semantics are
  still thin.
- The API surface mixes `defineResource(...)`, `Action.define(...).input(...).run(...)`,
  `UIState.define({ ... })`, object-literal screens, and object-literal programs.
- The demo uses React `useState` in a way that is actually valid, but the placement rule is not
  prominent enough.

Review 6 recommends these decisions:

1. Keep region-value projection patches as the canonical current patch model, but formalize a
   screen/program-owned projection manifest before adding more patch formats.
2. Treat routing as route-transition and layout state inside the framework model, with the React
   adapter driving URL/history or hash changes. Do not become a file-router-first framework.
3. Keep Bun-native as the canonical development host. Add asset pipeline hooks and Tailwind-style
   integration points before considering Vite as an optional adapter.
4. Converge public syntax around named framework declarations and builder-style APIs.
5. Officially document local React state as valid local-only UI state, not a violation of the
   server-program model.

## Current Implementation Truth

### Patches Are Projection-Region Patches

The current patch protocol is not DOM patching, React reconciliation, React Flight, JSON Patch, or
resource-value subscription delivery.

It is:

```txt
resource invalidation
-> affected observed projection regions
-> recompute projection
-> send changed region values
-> adapter applies those values to projection state
```

Server evidence:

- `ProjectionPatchEnvelope` carries `kind: "region-values"`.
- `context.region(id, read)` records both region value and resources read by that region.
- `refreshAffectedViews()` asks the runtime store for views observing invalidated resources.
- `patchEnvelope()` sends region values when all affected regions are JSON-serializable.
- Unpatchable region values fall back to full `projection:update`.

Client evidence:

- `ProjectionPatchManifest` maps region IDs to patch strategies.
- The React adapter can apply `replace-at-path`, `replace-fields`, or `custom` strategies.
- The approval demo uses a manifest for `pendingDeployments`, `selectedDeployment`, `activeRuns`,
  and `tracePanel`.

This is a good current direction because it preserves the framework's semantic unit:

```txt
Region = the named part of a projection whose value depends on observed resources and UI state.
```

That is more meaningful than arbitrary path patches at this stage.

### Routing Exists, But App Navigation Does Not

The current router can:

- define a route pattern with schema-backed params
- match concrete paths like `/contract/main`
- select among multiple registered screens
- reject invalid params by failing route match
- persist route and params in a `ViewCheckpoint`

That is useful, but it is not yet a real app routing model.

Missing:

- client-side URL integration
- browser back/forward behavior
- hash-router mode
- navigation as a program/system input
- nested layouts
- layout-persistent UI state
- route-scoped UI checkpoint policies
- shared resources across layout and page regions

The approval demo still hardcodes one route in the server initial render and the client stream
setup. So the implementation proves screen resolution, not application navigation.

### Bun Development Is Reload-Based, Not HMR

The Bun host currently:

- builds the browser entry with `Bun.build`
- serves `/client.js` and optional `/styles.css`
- injects a dev reload websocket in watch mode
- watches the client entry directory and stylesheet directory
- reloads the page after rebuild

The stream client currently:

- reconnects with backoff
- persists latest cursor in storage
- sends stored resume state on reconnect
- rejects sends while disconnected
- attaches client-generated input IDs to browser-originated inputs

This is a good early Bun-native story, but it is not hot module replacement. The bet is currently:

```txt
Fast full reload + real stream resume is good enough for now.
```

That is a reasonable bet if reload/reconnect becomes excellent. It is not yet enough for Tailwind,
shadcn-like workflows, or complex asset pipelines without more host hooks.

### API Syntax Reflects Prototype History

The framework currently exposes several declaration styles:

- `defineResource("PendingDeployments", loader)`
- a separate resource-key factory function such as `PendingDeployments(teamId)`
- `Action.define("action.approveDeployment").input(schema).run(...)`
- `UIState.define({ init, events: [...] })`
- plain screen objects with `{ route, project }`
- `defineProgram({ resources, uiState, screen, actions })`
- route builders through `Route.define(pattern, { params })`

Some of this is justified by TypeScript inference pressure. But public DX currently feels like each
concept was designed in a different stage.

This is not only aesthetic. API shape teaches the framework's mental model. If definitions look
unrelated, users will assume the concepts are unrelated too.

### React `useState` Is Not A Model Violation

The approval demo uses local React state for `deploymentFilter`.

That is consistent with the Stage 7 Domain/UI state model:

- `deploymentFilter` is local-only UI state.
- `selectedDeploymentId` is projected/checkpointed UI state because the server projection depends
  on it.
- deployment approval status is domain state.

The project should not sell "no React state." It should sell explicit state placement:

```txt
Local-only UI state stays in the renderer.
Projected or checkpointed UI state enters UIState through UIEvents.
Workflow truth belongs in resources and actions.
```

## Decision 1: Keep Region-Value Patches, Formalize The Manifest

### Decision

Keep `region-values` as the canonical current patch protocol.

Do not jump directly to JSON Patch, DOM patches, React tree patches, or Flight payloads. Those may
be useful later, but they should not replace the semantic region model before the project proves
larger screens and layouts.

### Why

Region-value patches line up with the framework's core dataflow:

```txt
screens observe resources in named regions
actions invalidate resources
runtime finds affected regions
adapters update projection state
```

JSON Patch would make the patch protocol look more standard, but it would shift attention from
semantic regions to object paths. That is not obviously better. It also couples the server to a
client projection layout unless a manifest exists anyway.

UI-tree or React/Flight patches may eventually be more powerful, but they would force renderer
questions into the kernel too early.

### Required Contract

The patch contract should become explicit:

- A region ID is a stable public identifier within a screen or layout projection.
- A region may declare a schema or value type.
- A region may declare whether it is patchable.
- Patchable region values must be JSON-serializable.
- Each screen or program exposes a projection patch manifest.
- The React adapter consumes the manifest instead of app-specific handwritten handlers.
- Manifest version mismatch must trigger a full projection refresh.
- Missing region strategy must be recoverable, not a permanent client failure.
- Full projection fallback remains part of the protocol.

### Proposed Shape

Illustrative, not final:

```ts
const ApprovalScreen = Screen.define("approval.deployments")
  .route("/teams/:teamId/deployments", { params: TeamRouteParams })
  .regions({
    pendingDeployments: Region.value({
      patch: Projection.replaceAt(["pendingDeployments"]),
    }),
    selectedDeployment: Region.value({
      patch: Projection.replaceAt(["selectedDeployment"]),
    }),
    tracePanel: Region.value({
      patch: Projection.replaceFields([
        { from: ["open"], to: ["tracePanelOpen"] },
        { from: ["traces"], to: ["traces"] },
      ]),
    }),
  })
  .project(...);
```

The important shift is ownership: the manifest belongs near the projection definition, not buried
inside the demo's React component.

### Acceptance Criteria

- The approval demo's patch manifest is declared at the screen/program boundary.
- React adapter patch application no longer requires approval-specific logic in the app component.
- Patch envelopes include enough manifest/projection version data for compatibility checks.
- Unknown or incompatible patch strategies can request or accept a full projection update.
- Tests cover region patch success, missing strategy fallback, manifest version mismatch, and
  unpatchable full-refresh fallback.

## Decision 2: Build Route Transitions And Layouts, Not A File Router

### Decision

Routing should become a framework-level route-transition model. The React adapter should drive it
from URL/history or hash changes, but the kernel should understand navigation because navigation
changes view checkpoints, observed regions, projection baselines, and delivery semantics.

Do not make a file-router-first framework as the next step.

### Why

The project is not trying to compete with Next.js as a page framework. But real apps still need:

- URLs
- multiple screens
- shared layouts
- route transitions
- browser back/forward
- route-specific and layout-persistent UI state

If routing stays only as "the connect envelope has a route string," every non-trivial app will
invent navigation outside the framework. That would undermine view checkpoints, resource
observation, and traceability.

### Proposed Model

Navigation should be a system input:

```txt
SystemEvent.navigate
  current view id
  target path
  route params after match
  navigation kind: push | replace | pop | hash
  resume/checkpoint policy
```

The runtime should:

- resolve the target route
- decide whether to reuse the current view or create a new view checkpoint
- update route and params
- preserve layout UI state when appropriate
- reset or restore screen UI state based on policy
- recompute layout and page projection regions
- emit a projection update or patch sequence
- record trace events under a system/navigation phase

### Layouts

Layouts should not be decorative React wrappers only. In this model, layouts are persistent
projection boundaries.

They can:

- observe shared resources
- own layout-level UI state
- remain stable across child route transitions
- define patchable regions
- provide shell projection data to React

The first useful layout model can stay small:

```txt
Program
  layout: OperationsLayout
    route scope: /teams/:teamId/*
    UI state: nav panel open, trace panel mode
    resources: team, current user
  screens:
    /teams/:teamId/deployments
    /teams/:teamId/runs
```

This gives the framework a real proof point without introducing file routing.

### URL Router And Hash Router

URL/history and hash routing should be adapter modes:

- `history` mode reads and writes normal browser paths.
- `hash` mode reads and writes `location.hash`.

Both should produce the same framework navigation input. The kernel should not care whether the
path came from history or hash.

### Acceptance Criteria

- A demo can navigate between at least two screens without a full browser reload.
- Browser back/forward triggers framework navigation and projection recomputation.
- A shared layout region persists across child screen transitions.
- Layout UI state can persist while screen UI state resets or restores by policy.
- Route params are decoded through route schemas on navigation, not only initial connect.
- Navigation failures produce typed runtime errors or not-found projections.

## Decision 3: Keep Bun-Native Canonical, Add Asset Hooks

### Decision

Keep the current Bun-native host as the canonical development path.

Do not make Vite the default. Vite may become an optional host or asset adapter later, but the core
project should continue proving the low-dependency Bun-native path.

### Why

The framework's host model is part of the experiment:

```txt
Bun host + framework stream + server program runtime
```

Defaulting to Vite too early would make the development experience easier in the short term, but it
would also hide important host responsibilities:

- stream reconnect behavior
- initial render bootstrap
- reload/resume after server restart
- client bundle generation
- CSS and asset delivery
- future serverless host boundaries

The Bun path should be made better, not abandoned.

### What The Current Dev Server Should Become

Near-term Bun dev should target:

- deterministic one-shot production build
- dev watch rebuild for client entry, imported modules, styles, and static assets
- reload channel with clear connection state
- robust browser reconnect after reload or server restart
- explicit dev diagnostics for build failures
- asset pipeline hooks for CSS processors and copy steps
- a documented Tailwind integration path

Hot module replacement is not required yet. Full reload is acceptable if reload and resume are
fast, reliable, and honest.

### Tailwind And shadcn Direction

Tailwind should be treated as an asset pipeline integration, not as a kernel feature.

The host should make this easy:

```ts
serveBunProgram({
  assets: {
    styles: [
      {
        input: "src/styles.css",
        output: "styles.css",
        watch: ["src/**/*.{ts,tsx}", "src/styles.css"],
        build: tailwind(),
      },
    ],
  },
});
```

The exact API can change. The important contract is:

- the framework host knows when asset output changed
- the browser reloads or refreshes consistently
- CSS changes are not confused with server-program state
- users can bring Tailwind/shadcn-like workflows without replacing the canonical host

### Reconnect And In-Flight Actions

Current reconnect is a good base, but action recovery is not done.

The next recovery work should define what happens when a connection drops after the browser sends
an action but before it receives the result:

- not received
- accepted but not committed
- committed but result not delivered
- failed
- unknown

Client input IDs and input records already point in the right direction. They now need a real
dedupe/recovery policy.

### Acceptance Criteria

- Editing client code rebuilds and reloads predictably.
- Editing styles rebuilds and reloads predictably.
- A Tailwind-based demo or fixture can run without Vite.
- Browser reconnect after dev reload uses the normal resume path.
- Server restart behavior is documented for memory store versus file store.
- Build failures are visible without leaving the browser in a misleading state.
- In-flight action recovery has a typed outcome or explicitly remains unsupported with a clear
  client error.

## Decision 4: Converge On Named Builder APIs

### Decision

Move the public API toward consistent named framework declarations with builder-style composition.

Do not rewrite every implementation immediately. First define the target API grammar, then migrate
the approval demo and contract tests toward it.

### Why

Syntax is part of architecture. Current syntax makes the framework feel more inconsistent than the
underlying model actually is.

The framework concepts are parallel:

- Program
- Resource
- Action
- UIState
- Screen
- Route
- Layout
- Region

Their declaration style should also feel parallel.

### Proposed Grammar

Illustrative target:

```ts
const PendingDeployments = Resource.define("PendingDeployments")
  .key(Schema.Struct({ teamId: Schema.String }))
  .load((key) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pending(key.teamId);
    }),
  );

const approveDeployment = Action.define("deployment.approve")
  .input(Schema.Struct({ deploymentId: Schema.String }))
  .run((input, context) =>
    Effect.gen(function* () {
      // domain transaction
    }),
  );

const ApprovalUI = UIState.define("approval.ui")
  .init(() => ({ selectedDeploymentId: null }))
  .event("deployment.select", SelectDeployment, (state, event) => ({
    ...state,
    selectedDeploymentId: event.deploymentId,
  }));

const ApprovalScreen = Screen.define("approval.deployments")
  .route("/teams/:teamId/deployments", { params: TeamRouteParams })
  .ui(ApprovalUI)
  .regions(...)
  .project((view, context) => ...);

const ApprovalProgram = Program.define("approval")
  .layer(ApprovalLayer)
  .resources(PendingDeployments, Deployment, AuditTrail)
  .actions(approveDeployment)
  .screens(ApprovalScreen);
```

The exact names can change. The important direction:

- declarations are named
- schemas are colocated with the thing they validate
- resources own their key factory
- screens own route, regions, and projection manifest
- programs compose named declarations
- object literals remain for low-level options, not core public concepts

### Resource API Pressure

Resources are the most obviously inconsistent today because key factories and definitions are
separate.

Target behavior should let app code say one of:

```ts
PendingDeployments.key({ teamId });
PendingDeployments({ teamId });
```

and use the same declaration for registration and invalidation.

This would remove a large amount of accidental ceremony:

```ts
function PendingDeployments(teamId: string): ResourceKey<Deployment[]> { ... }

defineResource("PendingDeployments", ...)
```

### UIState API Pressure

`UIState.define({ init, events: [...] })` works, but it does not match `Action.define(...).input`.

Builder-style UI events would make the distinction clearer:

```txt
Action = domain transaction
UIState.event = view/editing transition
```

### Screen API Pressure

Plain screen objects are currently too underpowered for the next stage. Once screens own route,
regions, patch manifests, and layout relationships, they should become first-class declarations.

### Acceptance Criteria

- A new developer can scan Resources, Actions, UIState, Screens, and Program definitions and see
  one consistent declaration grammar.
- Resource definitions own key creation.
- Screen definitions own region IDs and projection manifest data.
- The approval demo can be rewritten without increasing ceremony.
- Existing low-level APIs can remain internally or under compatibility exports during migration.

## Decision 5: Make State Placement Rules Public

### Decision

Document local React state as part of the UI tier, not as an escape hatch.

### Public Rule

```txt
If losing it only changes presentation, it can be local UI state.
If the server projection or resume depends on it, model it as UIState.
If losing it corrupts workflow truth, permissions, sharing, audit, or durable process state,
model it as domain state through resources and actions.
```

### Examples

| State                      | Placement           | Reason                                  |
| -------------------------- | ------------------- | --------------------------------------- |
| hover state                | local UI            | presentation only                       |
| dropdown open              | local UI by default | presentation only                       |
| text filter                | local UI by default | presentation unless saved/shared        |
| selected deployment        | UIState             | server projection reads selected detail |
| trace panel open           | UIState or local UI | depends on resume/debug policy          |
| action pending indicator   | adapter UI state    | tied to input lifecycle                 |
| deployment approval status | domain resource     | workflow truth                          |
| audit entry                | domain resource     | durable causal record                   |
| AI run progress            | domain resource     | durable process state                   |
| stream cursor              | runtime checkpoint  | recovery state, not app state           |

This rule should appear in README and Developer Experience docs before the next public API pass.

## Recommended Work Order

### 1. Write The Contract Before Rewriting The API

Produce short specs or docs for:

- projection region and patch manifest contract
- route transition and layout model
- Bun dev host and asset pipeline responsibilities
- public API grammar
- UI state placement rules

The goal is not more paperwork. The goal is to prevent the next code pass from encoding accidental
syntax.

### 2. Move Patch Manifest Ownership To Screens

Before adding route/layout complexity, move the approval demo's patch manifest out of the React app
component and into a screen/program-owned declaration.

This is the smallest step that makes the patch protocol feel intentional.

### 3. Add A Two-Screen Layout Spike

Use the existing approval domain. Do not invent a second unrelated demo yet.

Possible shape:

- `/teams/:teamId/deployments`
- `/teams/:teamId/runs`
- shared `OperationsLayout` with team/current-user/trace shell
- layout-level region and screen-level regions

This should prove navigation, layout persistence, shared resources, and patch fanout.

### 4. Harden Bun Dev Asset Flow

Add just enough host extensibility to make a Tailwind-style workflow pleasant:

- style build hook
- watch globs
- build error reporting
- reload behavior
- docs or fixture

Do not build a full HMR system yet.

### 5. Run A Syntax Spike

Define the target builder API in a branch or doc, then migrate one vertical slice:

- resources
- actions
- UI state
- screen
- program

Judge it by the approval demo, not by abstract preference.

### 6. Then Decide Compatibility Strategy

After the syntax spike proves itself, decide whether old APIs remain as:

- internal helpers only
- compatibility exports
- deprecated aliases
- removed prototype surface

Because this is still v0.0.0, removal is acceptable if it produces a cleaner framework.

## Open Questions

These do not block the recommended next work, but they should stay visible.

### Are Layouts Separate Declarations Or Specialized Screens?

The first spike can answer this. A separate `Layout.define(...)` may be clearer, but a generalized
screen tree may be simpler.

### Should Resource Keys Be Object Params Only?

Object params are more schema-friendly and future-proof than positional strings, but they add
ceremony for simple resources. The syntax spike should test both.

### Should Patch Manifests Use Runtime Schemas?

Schemas would make patch compatibility and adapter validation stronger. They may also make
projection authoring heavier. Start with manifest version and region IDs, then add schemas if tests
expose drift.

### How Much Should The React Adapter Own Navigation?

The adapter should own browser APIs. The kernel should own route resolution, view checkpoint
updates, and projection recomputation. The boundary between them needs a concrete spike.

### Should Vite Exist As An Optional Adapter?

Not now as the default. It may still be valuable later as an optional dev host for ecosystem-heavy
projects. The Bun path should be made good first.

## Non-Goals For The Next Stage

- Do not replace the custom stream with React Flight.
- Do not implement DOM patches.
- Do not build a file-router-first framework.
- Do not make Vite the canonical dev server.
- Do not add a second unrelated product demo before route/layout contracts are clearer.
- Do not build full HMR before reload/resume is excellent.
- Do not make every local UI interaction cross the server.
- Do not rewrite all APIs before the target grammar is proven against the demo.

## Updated Contract Map

| Area            | Current state                                    | Review 6 direction                                         |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Patch protocol  | Region-value patches plus client manifest        | Formal screen/program-owned projection manifest            |
| Patch fallback  | Full projection fallback exists                  | Keep fallback mandatory and test adapter recovery          |
| Routing         | Connect-time route matching and screen selection | Route transitions as system inputs                         |
| Layouts         | Not represented                                  | Persistent projection boundaries with UI/resource scope    |
| URL handling    | Hardcoded demo route                             | React adapter history/hash modes driving navigation inputs |
| Bun dev         | Bun build, watch, full reload                    | Canonical host with asset hooks and better diagnostics     |
| Tailwind/shadcn | Possible manually, not first-class               | Asset pipeline integration, not kernel feature             |
| Reconnect       | Backoff and resume cursor                        | Add in-flight input recovery semantics                     |
| API syntax      | Mixed prototype styles                           | Named builder declarations                                 |
| Resources       | Definition and key factory separated             | Resource declaration owns key creation                     |
| UI state        | Correct model, underexplained local state        | Public placement rules across local/UIState/domain         |
| Demo            | One approval route                               | Same domain with two screens and shared layout             |

## Bottom Line

The framework should keep its center:

```txt
Build webapps as durable server programs.
Domain state is workflow truth.
UI state is view/editing context.
Resources and actions replace API/cache glue.
The runtime owns projection, patches, resume, and traces.
React renders and hosts local UI where appropriate.
Bun is the first canonical host.
```

Review 6 is not a pivot away from Stage 8. It is the next cleanup pass after Stage 8 made the
runtime more real.

The next stage should make the framework feel less like accumulated experiments and more like one
designed system:

```txt
formal projection manifests
+ route transitions and layouts
+ Bun-native asset/reload DX
+ consistent named declaration syntax
+ explicit state placement rules
```
