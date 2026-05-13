# Framework State Review 3

## Purpose

This report audits the current framework after Stage 5 and sets the Stage 6 architecture
direction. It is intentionally stricter than a backlog. The goal is to decide which current
shapes should become foundations, which should be treated as prototype debt, and which should
be removed or redesigned before more features are added.

This is a review and decision spec, not an implementation patch.

Sources reviewed:

- `docs/design/model.md`
- `docs/design/runtime.md`
- `docs/design/developer-experience.md`
- `docs/design/experiments.md`
- `docs/proposal.md`
- `docs/prototype-plan.md`
- `docs/kernel-hardening-plan.md`
- `docs/framework-state-review.md`
- `docs/framework-state-review-2.md`
- `docs/stage-5-record.md`
- `src/framework/*`
- `src/client/*`
- `src/demo/approvals/*`
- `tests/*`
- `README.md`
- Effect docs: [services](https://effect.website/docs/requirements-management/services/),
  [layers](https://effect.website/docs/requirements-management/layers/),
  [runtime and ManagedRuntime](https://effect.website/docs/runtime/),
  [schema](https://effect.website/docs/schema/getting-started/), and
  [`Effect.tryPromise`](https://effect-ts.github.io/effect/effect/Effect.ts.html).

## Current Verification State

- Worktree is clean.
- `bun test` passes: 38 tests.
- `bun run check` passes: typecheck, lint, and format check.

Stage 5 is a real improvement. Region-value patches, host session delivery, bootstrap rendering,
patch replay fallback, trace fanout, and client patch tests are now present. The framework is not
only metadata wrapped around full projection replacement anymore.

The next risk is different: the project can now accidentally polish the wrong public API and make
the prototype boundaries feel permanent. Stage 6 should be an architecture correction pass before
another feature pass.

## Executive Summary

The core thesis still holds:

```txt
browser event
-> typed message
-> server program
-> effect transaction
-> resource changes
-> recomputed projection
-> streamed patch
```

But several implementation choices now conflict with that thesis:

- Effect is not actually the capability model. Services are plain `TServices` objects passed
  through framework contexts.
- Resource, store, projection, and host failures still behave like ordinary thrown or rejected
  JavaScript in places where the framework should have typed failure semantics.
- The public API requires too much manual generic threading and too much user-written plumbing.
- Routes look declarative but are exact string lookups; `"/teams/:teamId/deployments"` is not
  currently a route pattern in the kernel.
- Plugins and middleware do not exist. Trace observes after the fact but cannot shape execution.
- Session persistence and stream persistence exist, but the contract is not strong enough for
  multi-process or serverless claims.
- Framework code, React adapter code, demo app code, and global CSS are still too close together.

The Stage 6 direction should be:

```txt
Effect-native kernel
+ schema-backed messages/routes/resources
+ hybrid public API over plain manifests
+ core hook/plugin pipeline
+ contract-first persistence
+ clearer adapter and demo boundaries
```

Renderer/UI-tree work should stay out of Stage 6 implementation scope. The API and plugin design
must still preserve future renderer adapters, including a framework UI tree or React Flight-style
adapter.

## Complaint Audit

### 1. Effect Is Decorative Today

Current evidence:

- `src/framework/effect.ts` only re-exports `Effect` and the `Context`/`Layer` types.
- `ActionContext<TServices>` exposes `services: TServices`.
- `ActionEffect<TResult>` is `Effect.Effect<TResult, ActionFailure, never>`.
- `defineProgram` stores `services: TServices`.
- Approval actions use `Effect.gen`, but service access is `context.services.auth.currentUser()`,
  wrapped with `Effect.sync`.

Grade: **Deviation**.

The critique is valid. The current system uses Effect mainly as generator syntax plus `either()`
for action failures. It does not use Effect's third type parameter, service requirements,
Context tags, Layers, ManagedRuntime, structured runtime provisioning, or resource-safety model.

This is not just cosmetic. It affects the main framework promise: "typed effects at the UI
boundary." Right now the compiler cannot see that an action requires Auth, Deployments, Audit, or
Clock. Tests can swap a plain service object, but the framework cannot compose, inspect, provide,
or constrain capabilities.

Decision: **Stage 6 should make Effect native, not optional and not decorative.**

Plain service objects should be treated as prototype debt. If a compatibility bridge is kept
during migration, it should be temporary and clearly named as an adapter from plain objects to
Effect Layers.

### 2. ResourceGraph.read Throws Outside The Failure Channel

Current evidence:

- `ResourceGraph.read()` records observation, checks the cache, looks up a definition, and throws
  `new Error("No resource registered for ...")` if no definition exists.
- Loader failures are caught only at projection runtime boundaries because `computeProjection`
  catches thrown errors around `screen.project`.
- Resource loaders return `Promise<T> | T`, not `Effect<T, ResourceError, R>`.

Grade: **Deviation**.

The complaint is valid, but the fix should be broader than wrapping only the missing-definition
case in `Effect.tryPromise`. In an Effect-native kernel, resource reads should be effects:

```ts
Resource.read(Deployment(id));
// Effect.Effect<Deployment, ResourceError | LoaderError, DeploymentService | ResourceRuntime>
```

Missing definitions, loader failures, stale/corrupt resource state, and serialization failures
should enter typed failure channels. Projection can still translate failures into stream error
envelopes, failed regions, or fallback projections, but raw exceptions should not be the normal
contract.

Decision: resource definitions and reads should move from Promise-returning loaders to
Effect-returning loaders with typed resource errors.

### 3. Store Implementations Are Prototype Stores

Current evidence:

- `MemoryRuntimeStore.readEnvelopesAfter()` scans the envelope array to find a cursor and filters
  by session afterward.
- `JsonFileRuntimeStore` reads and writes the entire JSON file for cursor allocation, envelope
  append, session save, and session load.
- Stage 3 and Stage 4 documents described JSON as a dev/test adapter, while README currently uses
  stronger durable language.

Grade: **Valid scaffold for tests, deviation for pitch language**.

The store critique is valid. The current adapters are acceptable for local proof and contract
tests, but not for a durability pitch. However, Stage 6 should not pick Redis, SQLite, Cloudflare,
or any production backend yet.

Decision: persistence should be contract-first. The next architecture should specify required
store behavior and adapter capabilities, then keep Memory/JSON as development adapters.

Required contract areas:

- monotonic cursor allocation per runtime or stream partition
- append and range-read envelope history by session without total-history scans in production
- session snapshot save/load with schema and framework version metadata
- retention and compaction semantics
- corrupted snapshot/envelope handling as typed store failures
- atomic batch behavior for "append envelope and save session"
- adapter capability metadata, such as `ephemeral`, `singleProcess`, `multiProcess`,
  `supportsRangeRead`, `supportsCompaction`, and `supportsPubSub`

### 4. Active Sessions Are Still Process Memory

Current evidence:

- `SessionStore` is a process-local `Map`.
- `RuntimeStore` persists snapshots and stream envelopes, but runtime active session lookup uses
  the in-memory `SessionStore`.
- Host delivery maps session IDs to sockets inside one Bun process.

Grade: **Valid scaffold, but serverless durability is not true yet**.

The critique is valid. The framework can restore session state when a client reconnects to a new
runtime with the same store, but active live sessions are not shared across processes. Two
processes have two session registries and two socket registries.

This does not mean session state must become durable truth. The design docs are right that
sessions are conversational. It does mean the framework needs a clearer model:

- **Session snapshot**: restorable conversational state.
- **Live session registry**: in-process active session object and observed regions.
- **Delivery registry**: host/socket attachment for a session.
- **Cross-process coordinator**: optional adapter for fanout, leases, or pub/sub.

Decision: Stage 6 should separate these roles. The core runtime should be able to restore a
session snapshot on demand, but cross-process live delivery should be an adapter capability, not
an assumption hidden inside `SessionStore`.

### 5. No Middleware Or Plugin System

Current evidence:

- Auth, validation, permission, writes, and audit are inline in action definitions.
- Trace events are manually added.
- There is no execution pipeline around actions, resources, sessions, routes, stores, host
  delivery, or rendering.
- `TraceStore` observes; it does not intercept.

Grade: **Missing**.

The critique is valid and Stage 6 should address it before more framework features land.

The goal is not a full Astro-style integration ecosystem yet. The goal is core hooks that prevent
every cross-cutting feature from being hardcoded into actions or runtime internals.

Decision: add a first-class core hook model to the architecture. Hooks should be Effectful,
ordered, typed, and scoped to framework concepts.

Required hook points:

- action input decode, before action, around action, after action, action failure
- resource read, cache hit/miss, loader failure, invalidation
- projection start, region start/end, projection failure, patch emitted
- route resolve and route mismatch
- session create, restore, update, snapshot, reject
- store read/write/replay/retention failure
- trace event creation and visibility filtering
- host connect/disconnect/send/fanout
- renderer adapter bootstrap, patch apply, fallback projection

Plugins should contribute hooks, Effect Layers, store adapters, host adapters, route helpers, or
renderer adapters. They should not mutate global singleton framework state.

### 6. Program Has Too Many Generics

Current evidence:

- `Program<TServices, TSessionState, TSessionMessage, TActionMessage, TProjection>` has five
  generic parameters.
- The approval app must call `defineProgram<ApprovalServices, ApprovalSessionState,
ApprovalSessionMessage, ApprovalActionMessage, ApprovalProjection>(...)`.
- Session and action messages are separate generic parameters even though both enter the stream
  as `{ type: string }`.

Grade: **Deviation for developer experience**.

The critique is valid. The framework currently asks users to manually thread types that can be
inferred from resources, actions, sessions, screens, and schemas.

Decision: the public API should infer program types from definitions. The implementer should not
write the five generic parameters in normal app code.

The replacement should model a single program message union at the stream boundary while retaining
separate action and session registries internally. Action and session messages are different
semantically, but developers should not have to manually merge or thread their types.

### 7. ProgramStreamReactState Is Too Wide

Current evidence:

- `ProgramStreamReactState` exposes connection, session ID, resume state, projection, projection
  version, cursor, traces, last result, last error, last patch, and send.
- Several fields are event history or debug state rather than durable render input.
- `useProgramStream` depends on the whole `options` object identity.

Grade: **Valid scaffold, API debt**.

The critique is valid. The hook is useful and tested, but the return shape is not a stable adapter
API. It exposes implementation details from the stream protocol instead of grouping state around
what React users need.

Decision: React adapter state should be grouped and partially derived:

```ts
const stream = useProgramStream(...)

stream.connection.status
stream.session.id
stream.session.resume
stream.projection.value
stream.projection.version
stream.actions.lastResult
stream.errors.last
stream.traces.visible
stream.send(...)
```

Patch envelopes should be observable through diagnostics or callbacks, not required as normal
render state. The adapter should also accept stable options or split stable connection options
from handler callbacks.

### 8. Global CSS Is Demo Debt

Current evidence:

- `src/client/styles.css` is one global 318-line stylesheet.
- `src/shell.html` loads `/styles.css`.
- `serveBunProgram` serves a single optional `stylesPath`.
- `src/client` contains both reusable adapter code and approval demo UI code.

Grade: **Deviation for framework structure, acceptable for prototype styling**.

The critique is valid. The project is not a CSS framework, but the current layout makes demo
styling look like framework styling.

Decision: move styling ownership out of generic client/framework space. The React adapter should
not imply a global stylesheet. Demo styles should live with the demo or with a demo app package.
The host can serve app-provided assets, but the framework should not make global CSS feel like a
kernel concept.

## Effect-Native Architecture Decision

Stage 6 should commit to Effect as the native server capability model.

This means:

- Services are declared as `Effect.Tag` or `Context.Tag` values.
- Implementations are provided through `Layer`.
- A program creates or receives a `ManagedRuntime` at the runtime/host edge.
- Actions, resource loaders, route loaders, projection work, store operations, and plugin hooks
  return `Effect`.
- The third `Effect` type parameter carries required capabilities.
- Expected framework failures are typed values, not thrown exceptions.
- `Schema` is used for action input, session messages, route params, snapshots, and envelope
  decoding where runtime data crosses a trust boundary.
- `Effect.tryPromise` is used at async JavaScript boundaries that can reject, including file
  stores, host IO, external clients, and adapter calls.

The framework should still hide Effect from browser contracts. Client messages, stream envelopes,
patch payloads, and React adapter state remain JSON/TypeScript shapes.

### Target Shape

Illustrative direction:

```ts
class Auth extends Effect.Tag("app/Auth")<
  Auth,
  {
    readonly currentUser: Effect.Effect<User, AuthError>;
  }
>() {}

const approveDeployment = Action.define("deployment.approve")
  .input(ApproveDeployment)
  .run(function* ({ deploymentId }) {
    const user = yield* Auth.currentUser;
    const deployment = yield* Deployments.find(deploymentId);

    yield* Permissions.require(user, "deployment:approve", deployment.teamId);
    yield* Deployments.approve(deploymentId, user.id);
    yield* Resource.invalidate(Deployment(deploymentId));

    return { deploymentId, status: "approved" as const };
  });
```

The important part is not this exact builder syntax. The important part is that service
requirements are visible in action/resource types and are provided once at the runtime edge.

### Runtime Boundary

The runtime should stop calling `Effect.runPromise` against effects with `R = never` as if all
dependencies were already closed over. Instead, the program runtime should own an Effect runtime:

```txt
Program manifest + Layer
-> ManagedRuntime
-> run action/resource/projection/store effects
-> map Exit/Cause into stream envelopes and traces
```

This also gives plugins a natural place to contribute Layers and instrumentation.

## API Design Decision

Stage 6 should choose a **hybrid public API**:

- App authors get small builder APIs where they improve inference, validation, and readability.
- The kernel consumes plain inspectable manifests produced by those builders.
- Advanced users and tests may construct manifests directly when that is clearer.

This is the best fit for the project because:

- Pure object APIs are explicit and "just JS", but they leak generics and push schema/message
  wiring onto users.
- Fluent builder APIs match the design docs and can infer types well, but they can become opaque
  if every concept is hidden behind chained methods.
- A hybrid keeps React-like explicitness: the output is still plain data/functions, while authoring
  helpers remove repetitive type plumbing.

### API Comparison

| Option      | Strengths                                                                       | Risks                                                             | Review decision                                           |
| ----------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| Object API  | Simple, inspectable, easy to test, close to current code                        | Manual generics, user-written validators, weak route/API guidance | Keep as internal manifest and advanced escape hatch       |
| Builder DSL | Good inference, matches docs, natural schemas/actions/routes                    | Can become magical and chain-heavy, may hide framework boundaries | Use for app-author surface where it removes real ceremony |
| Hybrid      | Explicit manifest plus ergonomic authoring, plugin-friendly, migration-friendly | Requires discipline to keep builders thin                         | **Choose this**                                           |

### Target Public Concepts

Program:

```ts
const program = Program.define("approvals")
  .provide(ApprovalLive)
  .resources({ deployment, pendingDeployments, auditTrail })
  .sessions({ approvalSession })
  .screens({ approvalsScreen })
  .actions({ approveDeployment })
  .plugins([Tracing.dev(), RateLimit.byUser()]);
```

Action:

```ts
const approveDeployment = Action.define("deployment.approve")
  .input(Schema.Struct({ deploymentId: DeploymentId }))
  .run(function* ({ deploymentId }) {
    // Effect-native transaction
  });
```

Resource:

```ts
const Deployment = Resource.entity("Deployment", DeploymentId, function* (id) {
  return yield* Deployments.find(id);
});

const PendingDeployments = Resource.query("PendingDeployments", TeamId, function* (teamId) {
  return yield* Deployments.pendingForTeam(teamId);
});
```

Session:

```ts
const approvalSession = Session.define("approval")
  .state(ApprovalSessionState)
  .init(() => ({ selectedDeploymentId: null, tracePanelOpen: true }))
  .message("selectDeployment", Schema.Struct({ deploymentId: DeploymentId }), (state, input) => ({
    ...state,
    selectedDeploymentId: input.deploymentId,
  }));
```

Screen and routes:

```ts
const approvalsRoute = Route.define("/teams/:teamId/deployments", {
  params: Schema.Struct({ teamId: TeamId }),
});

const approvalsScreen = Screen.define(approvalsRoute)
  .session(approvalSession)
  .project(function* ({ params, session }) {
    const pending = yield* Region.value("pendingDeployments", PendingDeployments(params.teamId));
    return { pending, selectedDeploymentId: session.selectedDeploymentId };
  });
```

These sketches should guide implementation but are not final syntax. The non-negotiable pieces are
schema-backed inputs, route params, inferred program messages, and Effect-native effects.

## Route Design Decision

Routes should become first-class definitions, not exact strings stored in a map.

Current behavior:

- Screens register routes like `"/teams/:teamId/deployments"`.
- Runtime `screenByRoute` is an exact `Map<string, ScreenDefinition>`.
- Demo initial render manually supplies `{ teamId: "team-platform" }`.

Stage 6 target:

- `Route.define(pattern, { params })` compiles pattern matching and param decoding.
- Screen definitions own route definitions.
- Runtime connection resolves a URL/path to one screen and decoded params.
- Resume stores route identity and decoded params.
- Route mismatch compares route identity plus canonical params, not only raw strings.
- Host adapters can ask the program to resolve an HTTP request instead of hardcoding demo params.

This will make the routes understandable and remove a major source of API confusion.

## Core Hook And Plugin Decision

Stage 6 should design core hooks before implementing another cross-cutting feature.

Plugins should be ordinary TypeScript values that can contribute:

- Effect Layers
- action middleware
- resource middleware
- route hooks
- trace processors
- store/session hooks
- host adapters
- renderer adapters
- dev-only diagnostics

Illustrative shape:

```ts
type FrameworkPlugin<R = never> = {
  readonly name: string;
  readonly layer?: Layer.Layer<R>;
  readonly hooks?: {
    readonly action?: ActionHooks;
    readonly resource?: ResourceHooks;
    readonly session?: SessionHooks;
    readonly route?: RouteHooks;
    readonly trace?: TraceHooks;
    readonly host?: HostHooks;
    readonly renderer?: RendererHooks;
  };
};
```

Hooks must be explicit about whether they can observe, transform, short-circuit, retry, or only add
trace metadata. The framework should not make every hook all-powerful by default.

This is the right middle ground before Astro-style integrations. It supports auth, logging,
metrics, rate limiting, retries, test fakes, store adapters, and future renderer adapters without
pretending there is already an ecosystem package model.

## Persistence And Session Contract Decision

Stage 6 should not choose a production store. It should specify the contract that production and
development stores must satisfy.

### Runtime Store Contract

The store should model three related but separate concerns:

- **Envelope log**: append and replay stream envelopes by session and cursor.
- **Session snapshots**: save and load conversational session state by session ID, route, and
  schema version.
- **Runtime metadata**: retention, compaction, cursor checkpoints, and adapter capabilities.

The API should move toward typed effects:

```ts
type RuntimeStore = {
  readonly append: (batch: StoreBatch) => Effect.Effect<void, StoreError>;
  readonly loadSession: (id: SessionId) => Effect.Effect<Option<SessionSnapshot>, StoreError>;
  readonly readAfter: (id: SessionId, cursor: Cursor) => Effect.Effect<ReplayResult, StoreError>;
  readonly compact: (policy: RetentionPolicy) => Effect.Effect<CompactionResult, StoreError>;
  readonly capabilities: StoreCapabilities;
};
```

`append envelope + save snapshot` should be a batch concept. Splitting those operations invites
inconsistent resume state.

### Versioning

Snapshots and envelopes should carry:

- framework protocol version
- app/program version
- session schema version
- projection schema version or projection adapter version
- route identity
- optional migration marker

If a version cannot be decoded or migrated, resume should return a typed rejection or refresh
reason. Corruption should never be a raw `JSON.parse` throw at the runtime boundary.

### Retention

The framework needs explicit retention semantics:

- how many envelopes may be replayed
- when a cursor becomes stale
- whether a projection baseline is required
- when snapshots are compacted
- whether trace history is persisted, compacted, or dev-only

Production adapters can implement these differently, but the stream protocol must expose stable
resume outcomes.

## Boundary Cleanup Decision

The repo should stop reading like a sandbox.

Recommended boundaries:

- Kernel: program, action, resource, session, projection, stream, trace, route, store contracts.
- Effect runtime: tags/layers/runtime helpers, typed errors, schema integration.
- Host adapters: Bun host and future serverless/worker hosts.
- Renderer adapters: React web adapter now, future UI-tree/Flight adapters later.
- Demo apps: approvals domain, demo React UI, demo styles, demo data.
- Dev assets: shell and CSS served by host options but owned by app/demo.

Concrete direction:

- `src/framework/bun-host.ts` should not be exported from the same primary barrel as kernel types
  forever.
- `src/client/react-adapter.ts` should live under a React adapter boundary, not beside approval UI.
- `src/client/approval-app.tsx`, `src/client/render-approval.tsx`, and `src/client/styles.css`
  should move toward demo ownership.
- README should stop overselling current stores as production durable behavior until the new
  contracts exist.

## Renderer Scope Decision

Stage 6 should explicitly defer renderer/UI-tree implementation.

Do not implement:

- framework-owned UI tree
- React Flight transport
- component protocol
- client island compiler

Do preserve:

- renderer adapter hook points
- projection/patch adapter interfaces
- route/bootstrap contracts that do not assume React forever
- Effect/resource/session concepts in the kernel, not in React code

This keeps the project UI-library agnostic at the kernel level without blocking a future renderer
adapter.

## Stage 6 Recommended Work Order

1. **Write the decision record and update pitch language**
   - Link this review from design docs.
   - Mark Memory/JSON stores as development adapters.
   - Clarify that Effect-native architecture is the target, while current services are prototype
     debt.

2. **Introduce Effect-native manifests behind compatibility**
   - Add tags/layers/runtime concepts.
   - Make action and resource execution accept effects with requirements.
   - Keep current approval demo working through a temporary bridge only if needed.

3. **Add schema-backed action, session, and route definitions**
   - Replace handwritten action/session validators with schema-backed decoding.
   - Introduce route definitions with param decoding and host request resolution.
   - Collapse manual program generic threading through inference.

4. **Design and implement core hooks**
   - Start with action/resource/session/trace hooks.
   - Add route/store/host hooks after the first hook pipeline is proven.
   - Keep plugins ordinary TypeScript values plus optional Effect Layers.

5. **Redesign persistence contracts**
   - Add store capability metadata, typed store errors, schema/version fields, and retention
     semantics.
   - Keep Memory and JSON as dev adapters that satisfy contract tests, not production claims.

6. **Clean framework/app/adapter boundaries**
   - Move React adapter and Bun host toward separate entrypoints.
   - Move demo UI and CSS out of generic client space.
   - Keep kernel imports free of Bun, React, and demo dependencies.

7. **Refine React adapter API**
   - Group hook state.
   - Make patch diagnostics optional.
   - Stabilize options identity behavior.

## Test And Acceptance Plan

Review-3 should lead to contract tests, not implementation-coupled tests.

Required new scenarios:

- Effect service requirements are type-visible in actions and resources.
- A program cannot run until required Layers are provided.
- Resource missing-definition and loader failures become typed resource failures.
- Store JSON parse/corruption failures become typed store failures.
- `Effect.tryPromise` wraps async store/host boundaries that can reject.
- Action input validation uses schema-backed decoding and reports structured validation errors.
- Session messages use schema-backed decoding and reject unknown messages.
- Route patterns resolve params predictably and reject invalid params.
- Resume compares route identity and decoded params.
- Store adapters expose capabilities and satisfy replay/retention/version contract tests.
- Plugins can observe and intercept action/resource/session execution without editing action code.
- Trace hooks can filter browser-safe output without relying only on event author discipline.
- React hook state can be grouped while existing projection/patch behavior remains observable.

Existing tests that should survive conceptually:

- connect produces initial projection
- session messages update conversational state
- unknown messages are rejected
- actions validate before mutation
- failed actions do not mutate durable state
- external invalidation fans out to affected sessions
- region patches update visible projection state
- unpatchable regions fall back to full projections
- route mismatch resume rejects explicitly
- stale cursor refreshes
- patch-only replay includes a projection baseline
- host delivery sends envelopes to target sessions
- browser-safe traces hide dev-only events

Tests likely to change shape:

- tests that manually call `defineProgram<...five generics...>`
- tests that rely on plain `TServices`
- tests that construct action validators by hand
- tests that assume exact route string lookup
- store tests that call low-level cursor functions instead of contract-level replay behavior

## Updated Contract Map

| Framework promise           | Current state                                      | Stage 6 decision                                        |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Effect-powered backend      | Mostly generator syntax and `either()`             | Make Effect Context/Layer/ManagedRuntime native         |
| Typed services/capabilities | Plain `TServices` object                           | Use Effect Tags and Layers                              |
| Resource reads              | Promise/sync loaders, throws on missing definition | Effect loaders with typed resource errors               |
| Action validation           | Handwritten type guards                            | Schema-backed decoding                                  |
| Routes                      | Exact string map with pattern-looking strings      | First-class route definitions and param schemas         |
| Plugins/middleware          | Missing                                            | Core hook pipeline before ecosystem integrations        |
| Store durability            | Dev stores, weak retention/versioning              | Contract-first adapters with capability metadata        |
| Active sessions             | In-process `Map`                                   | Separate snapshot, live registry, delivery, coordinator |
| React adapter               | Useful but wide hook state                         | Grouped adapter state and optional diagnostics          |
| CSS/app boundary            | Demo CSS in generic client area                    | Demo-owned styles and clearer adapter entrypoints       |
| Renderer/UI tree            | Deferred                                           | Preserve adapter boundaries only                        |

## Bottom Line

Stage 5 made patches and host delivery real enough that the next problem is no longer "does the
runtime update the browser?" The next problem is whether the framework's public architecture is
honest.

The current code proves the model can work, but it does not yet embody the strongest version of
the design docs. Effect is decorative, routes are confusing, stores are demo-grade, plugins are
missing, and the API makes users carry too much framework machinery by hand.

Stage 6 should therefore be an architecture correction pass:

```txt
make Effect native
make schemas/routes/messages explicit
make APIs infer instead of demanding generic threading
make plugins a real execution pipeline
make persistence contract-first
make framework/app/adapter boundaries obvious
```

Do this before adding UI-tree complexity, another demo slice, or production store adapters.
