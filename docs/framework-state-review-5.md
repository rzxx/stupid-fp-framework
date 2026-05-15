# Framework State Review 5

## Purpose

This report audits the framework after Stage 7 and sets the next research and implementation
direction. It is a post-Stage-7 honesty check, not an implementation patch and not a feature
backlog.

Stage 7 made the public model much clearer: Domain state, UI state, typed program inputs,
view checkpoints, and a stateless-capable runtime now exist in code and docs. Review 5 asks a
harder question:

```txt
Is the current architecture honest enough for the project's serverless, horizontal-scaling,
adapter-agnostic ambition?
```

The answer is: partially. The prototype is real, but several claims are still softer than the
project direction requires.

This review covers runtime/serverless shape, stream recovery, client adapter protocol, resource
observation, patch semantics, auth context, demo scope, and optimistic UI. The feedback should not
be flattened into a feature list. Each complaint points at a design pressure that needs to be
challenged against the project vision:

```txt
Build webapps as durable server programs,
with explicit UI state instead of accidental client/server glue.
```

Sources reviewed:

- `README.md`
- `docs/design/model.md`
- `docs/design/runtime.md`
- `docs/design/developer-experience.md`
- `docs/design/experiments.md`
- `docs/framework-state-review-4.md`
- `docs/stage-7-record.md`
- `src/framework/stateless-runtime.ts`
- `src/framework/runtime.ts`
- `src/framework/store.ts`
- `src/framework/resource.ts`
- `src/framework/view.ts`
- `src/framework/stream.ts`
- `src/framework/bun-host.ts`
- `src/adapters/react/program-stream.ts`
- `src/adapters/react/projection-patch.ts`
- `src/adapters/react/react-adapter.ts`
- `src/demo/approvals/*`
- `tests/*`

## Current Verification State

This review did not add runtime behavior. It records the next direction based on existing code and
the Stage 7 verification record.

Current evidence:

- `docs/stage-7-record.md` says `bun test` passed 46 tests and `bun run check` passed at Stage 7
  completion.
- `createStatelessRuntime` in `src/framework/stateless-runtime.ts` creates a fresh runtime for
  each `connect`, `receive`, `affectedRegions`, and `invalidate` call.
- The `traces` getter on `createStatelessRuntime` also creates a fresh runtime, which means trace
  state is not a stable stateless service and the API shape still leaks process-oriented runtime
  thinking.
- `createRuntime` still constructs `LiveViewRegistry` and `TraceStore` in process memory, then
  uses the runtime store to restore checkpoints when needed.
- `RuntimeStore` has `listViews()` and a `supportsObservationIndex` capability flag, but no
  observation-index read/write API. Current stateless invalidation restores all checkpointed views
  and scans their observed regions.
- Runtime persistence currently allocates cursors, appends envelopes, and saves checkpoints as
  separate operations, so there is no atomic invocation commit contract.
- `connectProgramStream` persists cursors and sends resume state on initial connect, but it does
  not reconnect after close, does not retry, does not use backoff, and does not define queued-input
  behavior.
- Client input envelopes do not carry client-generated input IDs or acknowledgement/result
  correlation, so reconnect cannot safely reason about in-flight actions.
- `serveBunProgram` builds the browser client once at server startup. It does not run a separate
  dev server, watch rebuild, hot reload, or HMR loop.
- `SocketDelivery` in `src/framework/bun-host.ts` maps view IDs to sockets inside one Bun process.
  This is useful for the local host but does not prove cross-process delivery.
- `applyRegionValuePatch` requires app-authored region handlers. It is generic over projection
  type, but the approval app still hardcodes how each region maps into `ApprovalProjection`.

## Executive Summary

The framework has a coherent model. The Stage 7 vocabulary is a strong improvement over the older
session/message model. The current loop is understandable:

```txt
client input
-> runtime restores or creates view context
-> action or UI event runs through Effect
-> resources are read or invalidated
-> projection regions are recomputed
-> stream envelopes carry patches and traces
-> React adapter renders projection state
```

The problem is that the scaling, recovery, and adapter contracts are not yet honest enough.

The next work should be prioritized in this order:

1. Stateless/horizontal invocation and atomic commit contract.
2. Store/coordinator, cursor ordering, and atomic commit semantics.
3. Client recovery with reconnect, backoff, resume, and client-generated input IDs.
4. Invocation context, auth, and scoped resource invalidation.
5. Observation index with a concrete `fanoutScope` dimension.
6. Patch/protocol/adapter boundary.
7. Demo complexity and optimistic UI.

The central Stage 8 move should be:

```txt
Turn "stateless-capable runtime" from a wrapper over live runtime methods
into an invocation contract with explicit input identity, atomic store commits,
delivery intents, cursor allocation, scoped observation-index updates,
and trace output.
```

That does not mean choosing Redis, SQLite, Durable Objects, Workers, Postgres, HLCs, vector clocks,
JSON Patch, or a schema registry now. It means defining the contracts that would let those choices
be made honestly later.

## Complaint Audit

### 1. Stateless Runtime Is Not Truly Stateless Serverless

**Current evidence.**

`createStatelessRuntime` recreates a normal runtime for every method call. The normal runtime still
allocates a process-local `LiveViewRegistry`, `TraceStore`, and resource graph cache. `receive`
can restore one checkpointed view by ID, and invalidation can restore all checkpointed views via
`listViews()`, but the stateless API is still shaped like a live runtime object.

The `traces` getter is the clearest smell. Accessing it constructs a new runtime and returns that
new runtime's trace store. That is not a durable or invocation-scoped trace service; it is a
compatibility leak.

**Validity.**

Valid. The implementation proves invocation isolation in tests, but it should be described as a
stateless-capable scaffold, not true stateless/serverless runtime architecture.

**Project requirement.**

The kernel must not require process memory to be correct. A host should be able to pass one
program input to the kernel and receive:

- input identity and idempotency outcome
- a store commit proposal or committed store result
- envelopes to append and deliver
- checkpoint writes
- observation-index writes
- trace events or snapshots
- delivery intents for connected views
- typed failures

**Options considered.**

- Keep the current wrapper and improve around it. This is fast, but it keeps the wrong center of
  gravity.
- Make `createRuntime` internally stateless while preserving the object API. This is less
  disruptive, but risks hiding important store and delivery contracts.
- Introduce an explicit invocation core and make Bun wrap it. This is the cleanest direction.
- Add an explicit store commit phase to the invocation contract. This is more upfront work, but it
  prevents the kernel from hiding multi-write consistency behind helper methods.

**Recommended next experiment.**

Add a `ProgramInvocation` or equivalent internal contract:

```txt
program manifest + invocation input + runtime adapters
-> invocation plan/result
-> atomic store commit
-> delivery intents
```

The existing `Runtime.connect`, `Runtime.receive`, and `Runtime.invalidate` methods can wrap that
core during migration, but tests should target the invocation result directly.

**Acceptance criteria.**

- A connect invocation computes a projection without a pre-existing live registry.
- A receive invocation restores one view checkpoint by ID, updates it, and returns a commit plan
  that persists envelopes, checkpoint changes, observation writes, trace output, and input-id
  records together.
- An invalidation invocation finds affected views through a store/coordinator contract, not by
  depending on process-local view state.
- Trace output is returned by the invocation or persisted through a trace adapter, not exposed
  through a process-local getter.

### 2. No Client Recovery Or In-Flight Input Semantics

**Current evidence.**

`connectProgramStream` sends a `connect` envelope on socket open and persists cursors from server
envelopes. On close it only reports `"closed"`. On error it only reports `"error"`. It does not
create a replacement socket, apply exponential backoff, resend resume state, classify close
reasons, or define what happens to inputs sent while disconnected.

The harder gap is not only reconnection. Client inputs have no stable client-generated input ID,
acknowledgement, or action-result correlation. If the socket closes after the browser sends an
action but before the browser receives the result, the protocol cannot answer whether the action was
not received, received but not committed, committed but not delivered, or should be safely retried.

**Validity.**

Valid. The server has resume semantics, but the browser client does not actually exercise them
after a dropped WebSocket. Resume exists at initial connection time, not as a recovery loop. The
review should treat input identity and in-flight semantics as part of recovery, not as a later
optimistic UI detail.

**Project requirement.**

Reconnect/resume is core protocol behavior. If the project is serverless-first, connection loss
and process loss are normal. The client adapter must treat them as expected states, not fatal UI
edge cases.

Recovery must also be action-safe. The protocol should be able to distinguish transport retry from
a new user intent. At minimum, each client-originated input needs an idempotency identity and a
defined lifecycle from sent, accepted, committed, delivered, and failed.

**Options considered.**

- Reconnect immediately on every close. Simple, but risks busy loops and duplicate work.
- Add exponential backoff with jitter and a retry limit. Better default for local and production.
- Add client input IDs and acknowledgement/result correlation. Required before retrying sends can be
  safe.
- Persist pending input state in the adapter. Useful, but only after the server protocol can
  dedupe or reject duplicates.
- Let apps own reconnection. This weakens the framework promise and duplicates protocol knowledge.

**Recommended next experiment.**

Add a reconnecting stream client with a Stage 8 scope limited to three things:

- reconnect with exponential backoff and jitter
- resume cursor read from storage on every reconnect attempt
- client-generated input IDs for every browser-originated input

Do not build typed recovery states, in-flight input queues, or complex send policies yet.
Start conservative: reject sends while disconnected and surface a typed client error.
Queueing inputs, action lifecycle correlation, and unknown-commit recovery should follow once
input-ID protocol and server-side idempotency records exist.

**Acceptance criteria.**

- Closing the socket triggers reconnect attempts with backoff.
- Reconnect sends the latest stored `{ viewId, cursor }`.
- `replayed`, `refreshed`, and `rejected` resume outcomes update adapter state predictably.
- Each sent input carries a stable client-generated input ID.
- Malformed server envelopes do not permanently kill the recovery loop.
- Tests use injected socket and timer dependencies.

Deferred until input-ID protocol and server idempotency exist:

- Server-side accepted/committed/failed outcome reporting correlated to input ID.
- In-flight action behavior after disconnect (recover, dedupe, reject, unknown-commit).
- Pending input queue while disconnected.
- Typed `recovering` connection state.

### 3. Bun Host Bundles Client On Every Server Start

**Current evidence.**

`serveBunProgram` calls `buildClient()` before `Bun.serve()`. `buildClient()` uses `Bun.build` for
one browser bundle and writes `app.js`. The dev script is `bun --hot src/server.ts`, which restarts
the server module but does not give the browser a proper dev-server or hot-reload experience.

**Validity.**

Valid for framework developer experience. It is not the deepest architecture problem, but it will
slow iteration as soon as the demo becomes more complex.

**Project requirement.**

Bun should remain the practical first host, but the host should not confuse "server restart" with
"client development server." A framework experiment still needs a tight feedback loop.

**Options considered.**

- Keep startup bundling for now. Acceptable while runtime architecture is changing.
- Add a simple watch rebuild and browser reload event. Good near-term fit.
- Integrate Vite or another dev server. Powerful, but conflicts with the Bun-native project
  direction unless treated as an optional adapter.
- Build a full HMR layer. Premature.

**Recommended next experiment.**

After reconnect work starts, add a Bun-native dev asset mode:

- watch the client entry and CSS
- rebuild on change
- expose a dev-only reload signal over a small client channel or reuse the framework stream with a
  system envelope
- keep production/simple mode as one build at startup

**Acceptance criteria.**

- Editing demo client code rebuilds without manually restarting the process.
- Browser reload or hot refresh reconnects using normal resume behavior.
- Production host path still performs a deterministic one-time build.

### 4. Single-Process Ceiling And Horizontal Scaling

**Current evidence.**

`SocketDelivery` maps view IDs to sockets inside one Bun process. `LiveViewRegistry` maps active
views inside one runtime instance. Runtime stores can restore checkpoints and envelope history, but
there is no cross-process delivery coordinator, no pub/sub adapter, no ownership lease, and no
store-backed observation index.

**Validity.**

Valid. The current system can simulate fresh invocations with a shared store in tests, but it does
not prove horizontal scaling.

**Project requirement.**

The kernel should produce delivery intents. The host or coordinator should decide how to deliver
those intents to connected clients across one process, many processes, or serverless edge
instances.

**Options considered.**

- Single Bun process only. Good demo, wrong project claim.
- Sticky sessions. Reduces complexity, but weakens serverless story and still needs reconnect
  after process death.
- Shared pub/sub coordinator. Good general shape for multi-process live delivery.
- Durable per-view actors. Strong model on platforms that support it, but too platform-specific as
  the core abstraction.

**Recommended next experiment.**

Split runtime output from host delivery:

```txt
invocation result
  protocol events / envelopes
  committed store writes
  delivery intents: viewId -> envelope cursors/envelopes
```

Then implement two coordinators:

- in-process Bun coordinator matching today's behavior
- test coordinator that simulates two runtime instances sharing a store and delivery bus

**Acceptance criteria.**

- An action handled by runtime A can produce a patch for a view connected to runtime B.
- The runtime does not need a socket map to compute affected views.
- The Bun host's socket registry is clearly local host state, not kernel truth.

### 5. Cursor And Store Commit Model Are Single-Writer

**Current evidence.**

`MemoryRuntimeStore` increments an in-memory number. `JsonFileRuntimeStore` reads a full JSON file,
increments `nextCursor`, then writes it back. Both are development adapters. Cursor strings look
globally monotonic in one writer, but there is no atomic multi-writer allocation contract.

Runtime persistence is also not one commit. `persistEnvelope()` allocates a cursor, appends one
envelope, mutates the live view cursor, then saves the view checkpoint. Projection recomputation
stores observed regions inside the checkpoint separately from any future observation index. In a
multi-writer or serverless setting, those operations need a consistency boundary.

**Validity.**

Valid. Single-writer cursors are enough for the current tests. They are not enough for
multi-process store semantics. Cursor allocation alone is not the full problem; Stage 8 must define
which writes commit together and how stale checkpoint writes are detected.

**Project requirement.**

Cursors must support replay and consistency. They do not necessarily need to encode all causality,
but the framework must define what ordering guarantee a cursor represents.

The store contract must also define an atomic mutation shape. An invocation should not be considered
successful if the stream envelope was appended but the checkpoint, trace output, or observation
index update failed in a way that leaves replay and fanout inconsistent.

**Options considered.**

- Store-assigned monotonic stream cursors. Recommended first. Let the persistence adapter allocate
  atomic cursor values per stream or partition.
- Atomic store commit for an invocation result. Stronger and necessary once one input can produce
  multiple envelopes, checkpoint changes, trace output, and observation-index updates.
- Compare-and-set checkpoint writes with expected checkpoint version. Necessary to prevent two
  invocations for the same view from silently overwriting UI state or observations.
- Lamport timestamps. Useful for causal ordering across processes, but still need a store tie-break
  and do not solve persistence by themselves.
- Hybrid logical clocks. Useful when wall-clock-ish ordering across partitions matters. More
  complex than current needs.
- Vector clocks. Strong for detecting concurrency relationships, but heavy for a UI stream and
  likely premature.

**Recommended next experiment.**

Define cursors as store-assigned opaque stream positions, then define the commit unit that allocates
and appends them. A production-capable store should expose one operation, or one transaction-like
adapter boundary, that can commit:

- one or more envelope appends with allocated cursors
- view checkpoint updates with expected checkpoint versions
- observation-index replacement for recomputed views
- trace writes or trace snapshots
- idempotency records for client input IDs

Keep HLCs as a later option if the framework needs cross-partition causal ordering for resource
events, background jobs, or collaboration.

**Acceptance criteria.**

- Cursor contract says whether ordering is per view, per program, per resource partition, or
  global.
- A single invocation result commits envelope appends, checkpoint writes, observation writes, trace
  output, and input-id records atomically or reports a typed partial/commit failure.
- Concurrent writes to the same view use expected checkpoint versions and cannot silently lose UI
  state or observations.
- Replay after cursor is deterministic for one view.
- Dev stores report their single-writer limitation in capabilities metadata.

Deferred until a multi-writer-capable store adapter exists:

- Concurrent cursor allocation tests (no duplicate cursors under parallel writes).
- Stale checkpoint write conflict tests against a real store contract.

The contract must define atomic commit and expected-version semantics now. Concurrent-write
verification should wait until there is a store adapter that can actually produce concurrent writes.

### 6. No Per-Request Auth Context

**Current evidence.**

The approval demo uses an `Auth` Effect service whose `currentUser()` is provided by the app layer.
That proves Effect can carry capabilities, but it does not model identity as a per-request or
per-invocation context. A long-lived layer can accidentally imply one current user for all inputs.

**Validity.**

Valid, with nuance. The project has the right underlying tool in Effect Context/Layer, but the
runtime does not yet define how browser identity, request metadata, and input context flow into
actions, resources, projections, and traces. This is no longer just an auth concern. It must shape
the observation index before resource fanout becomes a durable contract.

**Project requirement.**

Identity should be an invocation-scoped capability. It should be visible to effects and traces,
but not stored in global mutable state. Auth should be part of the program input boundary and
runtime context.

The same context should carry resource fanout scope. If a resource key such as
`PendingDeployments(team-a)` can exist in two tenants, teams, environments, or users' visibility
domains, the observation index must not fan out across those boundaries just because the serialized
resource key matches.

**Options considered.**

- Keep app-defined `Auth.currentUser()` only. Simple, but too easy to make global.
- Add `requestContext` directly to every action/resource/project callback. Explicit, but spreads
  plumbing.
- Provide an invocation-scoped Effect service. Best fit with the Stage 6 Effect-native direction.
- Fold scope into resource observation/index writes. Slightly more upfront design, but prevents the
  index contract from becoming global by accident.

**Recommended next experiment.**

Introduce an invocation context service that can include:

- principal or anonymous identity
- request ID
- connection ID
- tenant/team context if resolved by host
- resource visibility or fanout scope
- auth trace visibility policy

The host derives it from HTTP/WebSocket request metadata, and the runtime provides it while running
actions, resources, projections, and plugins.

This should land before the observation-index contract is finalized. It does not require building a
full auth product, but it does require the kernel/store interfaces to reserve scope as part of
observation and delivery decisions.

**Acceptance criteria.**

- Two simultaneous invocations can run with different identities through the same program.
- Auth identity is available through Effect requirements, not a process-global singleton.
- Observation-index writes and lookups include invocation/resource scope.
- A resource invalidation in one tenant/team/scope cannot fan out to views in another scope.
- Traces record safe identity metadata according to browser/dev visibility rules.
- Tests prove one user's input cannot observe another user's request context.

### 7. O(views) Scanning And The Missing Observation Index

**Current evidence.**

`RuntimeStoreCapabilities` includes `supportsObservationIndex`, and both current stores report
`true`. But the store interface has no methods to write or query an observation index. Runtime
invalidation calls `restoreCheckpointedViews()`, which calls `listViews()`, restores all snapshots
into the live registry, and then scans observed regions.

**Validity.**

Valid. The current flag overstates the implementation. The system has stored observations inside
view checkpoints, not an observation index.

**Project requirement.**

Resource invalidation should be able to answer:

```txt
Given resource key R and fanout scope S, which views and regions currently observe R in S?
```

without scanning every checkpointed view and without crossing tenant/team/visibility boundaries.

**Options considered.**

- Continue `listViews()` scans. Fine for development stores and small demos.
- Add a scoped store-backed resource-to-view index. Best next step.
- Push observation indexing to a separate coordinator. Good for production, but the kernel still
  needs an interface.
- Recompute every view on every invalidation. Simple but violates the resource graph promise.

**Recommended next experiment.**

Add observation-index contract methods:

```txt
replaceViewObservations(viewId, observationScope, observedRegions)
findViewsObserving(resourceKeys, observationScope)
removeViewObservations(viewId)
```

The runtime should write the index after projection recomputation and use it before restoring
affected views. The scope value should come from invocation context or an explicit host-provided
resource fanout scope, not from ad hoc app code inside a projection.

**Acceptance criteria.**

- Stateless invalidation queries affected view IDs without `listViews()`.
- Indexed invalidation includes scope and cannot select views outside the invalidated resource's
  fanout scope.
- Development stores can implement the index with maps or derived JSON state.
- Stores that do not support indexing must report `supportsObservationIndex: false` and trigger a
  clear fallback policy.
- Tests prove indexed invalidation only restores affected views.

### 8. Better Demo For Multiple Screens, Nested Layouts, And Complex UI State

**Current evidence.**

The approval demo is useful but narrow. It has one route, one main workspace, a local filter, a
checkpointed selected deployment, a trace panel, and a single workflow action. Tests include a
small multi-screen contract scenario, but the demo does not show multiple screens, nested layouts,
live resources, long-running process state, or richer UI state placement rules.

**Validity.**

Valid. The current demo proves the loop, but not the framework's intended fit for operational
apps with multiple connected surfaces.

**Project requirement.**

The demo should make the architecture easier to understand than conventional client/server
composition. It should expose the strengths and weaknesses of resources, UI state, traces,
patches, and reconnect.

**Options considered.**

- Add more features to the deployment approvals screen. Fast, but may create a crowded single
  screen.
- Add a second scenario such as incident timeline or AI task run. Better for live/process
  resources.
- Build a mixed operations console with nested layouts. Stronger proof, but should wait until
  reconnect and stateless contracts are less shaky.

**Recommended next experiment.**

After the runtime recovery work starts, expand the demo with one additional process-like resource:

- deployment approval remains the auth/audit workflow
- add a live run/timeline panel that progresses through resource events
- introduce a nested layout region that shares a resource with another screen

**Acceptance criteria.**

- Demo has at least two screens or nested screen regions.
- One resource is observed by more than one view/screen.
- One resource changes without direct user action.
- The trace panel can explain action-caused and resource-event-caused updates.

### 9. Brittle Observation Through AsyncLocalStorage

**Current evidence.**

`ResourceGraph.observe()` uses `AsyncLocalStorage` to collect resource reads per projection, and
`region()` switches the current region ID during an Effect. Tests prove concurrent observations
stay isolated for the current implementation.

**Validity.**

Partially valid. `AsyncLocalStorage` is a reasonable prototype mechanism in Bun/Node-like
environments, and current tests show it works for basic concurrent projection. The risk is future
adapter portability and explicitness, not immediate brokenness.

**Project requirement.**

Observation must be reliable across projection styles, async boundaries, host runtimes, and future
renderers. It should not become invisible magic that only works in one JS runtime shape.

**Options considered.**

- Keep `AsyncLocalStorage` as the only mechanism. Good local ergonomics, weak portability.
- Make observation explicit through a read context passed into resource APIs. More portable, more
  verbose.
- Use an observer token/capability in Effect context. Likely best fit with existing Effect-native
  direction.
- Combine ALS as an implementation convenience with explicit context as the contract.

**Recommended next experiment.**

Define observation as an explicit runtime capability, then allow the Bun/Node implementation to
back it with `AsyncLocalStorage` internally. The public resource read path should not require
global ambient state to be the only source of truth.

**Acceptance criteria.**

- Observation tests can run through an explicit observer context.
- Region nesting and concurrent projections remain isolated.
- The code can explain how a non-Bun host would implement observation.

### 10. `applyRegionValuePatch` And Patch Format Direction

**Current evidence.**

`ProjectionPatchEnvelope` carries `kind: "region-values"` with replacement values per region.
`applyRegionValuePatch` applies those values through handlers supplied by the app. The approval app
maps `pendingDeployments`, `selectedDeployment`, and `tracePanel` manually into
`ApprovalProjection`.

The runtime also returns `ServerEnvelope<TProjection>` directly as its result shape. That is useful
for the current vertical slice, but it means the invocation core can accidentally harden around a
transport/React-adapter envelope instead of a renderer-neutral protocol event model.

**Validity.**

Valid concern, but the solution is not obvious. Current region-value patches are honest and simple.
They are real patches, but they are still projection-shape specific at the adapter edge.

**Project requirement.**

Patch semantics must serve the server-program model and future adapters. The framework needs to
know whether it is patching:

- projection data
- named regions
- a framework UI tree
- React/Flight-like payloads
- adapter-specific render state

It also needs to know which layer owns the envelope. The kernel should produce framework protocol
events; stream and renderer adapters should encode those events into WebSocket payloads, React
state updates, Flight-compatible payloads, or future renderer formats.

**Options considered.**

- Keep region replacement patches. Good match for current named-region model.
- Use JSON Patch, RFC 6902. Generic and widely known, but path-based patches couple the server to
  projection object layout and can be fragile after schema changes.
- Use JSON Merge Patch. Simpler, but arrays are coarse and deletes/null semantics can be awkward.
- Use framework UI-tree patches. Strong long-term adapter story, much larger design burden.
- Use adapter-specific patch translators generated from a projection manifest. Promising middle
  ground, but needs a protocol spec first.
- Keep `ServerEnvelope<TProjection>` as the invocation result. Fastest migration path, but it lets
  transport details become kernel API.
- Introduce a minimal internal protocol event boundary. Slightly more design now, but keeps the
  invocation core from becoming React/websocket-shaped.

**Recommended next experiment.**

Do not jump directly to RFC 6902. First define the minimal protocol boundary and projection patch
protocol document:

- which events the invocation core emits before transport encoding
- what a region means
- who owns region IDs
- whether patches target projection data or renderer state
- how adapters discover patchable paths
- when full projection fallback is required
- how patch schema/version is represented

After that, spike JSON Patch for one projection shape and compare it against region replacement.

**Acceptance criteria.**

- A patch protocol spec exists before replacing `region-values`.
- Invocation tests can assert protocol events without depending on WebSocket/React envelope shape.
- The React adapter can apply a patch without app-authored per-region handlers in at least one
  tested path.
- Full projection fallback remains available for incompatible or unpatchable payloads.
- Patch failures produce recoverable adapter errors and can request/accept a full refresh.

### 11. Client Adapter As An Unexplored Design Goal

**Current evidence.**

The React adapter has a useful stream hook and grouped state. It still assumes projection data is
app-specific and patch application is provided by the app. There is no protocol manifest, schema
registry, codegen path, adapter capability model, or formal contract for non-React renderers.

**Validity.**

Valid. The kernel is conceptually renderer-agnostic, but the adapter contract is still mostly
"React receives whatever projection the app returns."

**Project requirement.**

React web should be the first adapter, not the architecture. Future adapters such as React Native,
desktop/native UI, terminal UI, or gpui-like targets need a protocol that is not just an
untyped blob plus handwritten patch functions.

**Options considered.**

- Keep app-defined projections only. Flexible, but every adapter becomes bespoke.
- Add a projection manifest with regions, schema/version, and patch capabilities. Best next step.
- Add codegen from schemas immediately. Useful later, premature before the manifest is stable.
- Add a schema registry. Useful for multi-language or remote adapters, but too heavy for now.
- Define a framework UI tree. Strong adapter story, but it changes the center of the project and
  should be a deliberate experiment.

**Recommended next experiment.**

Create a protocol/manifest design before codegen:

```txt
projection adapter manifest
  projection schema/version
  region IDs
  patch strategies per region
  trace extraction policy
  full-refresh fallback behavior
  adapter capabilities
```

React can be the first consumer. Other adapter sketches can be paper designs until the manifest is
clear.

**Acceptance criteria.**

- React adapter no longer needs approval-specific region handler knowledge for the canonical demo.
- Tests can validate a projection manifest against emitted patches.
- A non-React adapter sketch can explain how it would consume the same stream envelopes.

### 12. ResourceGraph Scoping And Shared Resource Coupling

**Current evidence.**

Each program owns one `ResourceGraph`. That graph has definitions, a cache, observation tracking,
and invalidation. View checkpoints store observed regions/resources. Shared resources across
screens are a core feature, but invalidation scoping is still global within the program graph.

**Validity.**

Valid as a future design pressure. Shared resources are the point of the model, but unchecked
global invalidation can couple unrelated screens and make large apps noisy.

**Project requirement.**

The framework should make shared resources safe and explainable. It needs invalidation domains,
resource scopes, or ownership conventions before demos grow into multi-screen programs.

**Options considered.**

- Program-global graph only. Simple and correct for current size.
- Scope resources by route/view. Avoids coupling but weakens sharing and can reintroduce cache
  soup.
- Add resource namespaces/domains. Likely useful for larger programs.
- Add invalidation policies per resource type. Powerful, but could become configuration-heavy.

**Recommended next experiment.**

The observation index contract must include at least one concrete scope dimension from the start,
not just a placeholder. Use a single `fanoutScope` string (or equivalent opaque scope token)
carried on every observation-index write and lookup. The host derives it from invocation context
(e.g., tenant, team, or environment), and the index must not return views whose scope does not
match the invalidation scope.

This is not the full scope taxonomy. Do not add namespaces, invalidation domains, or per-resource
policies yet. One scope dimension is enough to prevent the index contract from hardening as
global-by-accident. Adding a second dimension later is additive; retrofitting scope onto a
scopeless index is a breaking change.

Research the larger scope taxonomy as the demo grows:

- program scope (implicit default)
- tenant/team scope (derived from invocation context)
- view scope (narrow fanout)
- resource domain or namespace
- invalidation domain

Use the expanded demo to find which additional scopes deserve public names.

**Acceptance criteria.**

- The observation index contract carries a `fanoutScope` on every write and lookup.
- A resource scoped to one tenant/team cannot invalidate another tenant/team's views.
- Shared resource invalidation can explain why each affected view was selected.
- A resource observed by two screens updates both without manual fanout code.
- Trace details include enough resource labels/domain data to debug coupling.

### 13. Client Investment, Latency, And Optimistic UI

**Current evidence.**

The demo does not optimistically approve deployments. It waits for server action result and patch.
Traces already include validation, auth, permission, write, resource, projection, stream, and error
phases. `action:result` is still a single success/error envelope, not a lifecycle stream.

**Validity.**

Valid. If every action round trip costs 500ms, the UI needs a better pending and optimistic story.
But optimistic UI is dangerous if it rebuilds a client-side shadow of domain truth. Action
lifecycle is also a recovery primitive, not just latency polish: it is how the client knows whether
an input was accepted, committed, failed, or left in an unknown state after reconnect.

**Project requirement.**

Optimism should be trace-driven and server-program-shaped. It should not become React Query style
manual cache mutation under another name.

Before optimistic mutation is considered, action lifecycle envelopes should integrate with the
input-id and acknowledgement protocol from client recovery.

**Options considered.**

- No optimistic UI. Simple and honest, but latency will feel bad.
- Generic optimistic projection patches from the client. Risky because the client invents server
  truth.
- Action lifecycle envelopes with pending stages. Good foundation.
- Input-ID-correlated lifecycle envelopes. Required foundation for recovery and optimism.
- Declarative optimistic hints on actions. Promising after lifecycle exists.
- Trace-stage UI that shows exactly where an action is blocked or failed. Strong fit for project
  identity.

**Recommended next experiment.**

Start with action lifecycle, not optimistic mutation, and correlate lifecycle events to the client
input ID:

```txt
input:accepted(clientInputId)
action:started(clientInputId)
action:stage(clientInputId, validation/auth/write/projection)
action:result(clientInputId)
```

Then add a narrow optimistic experiment where an action can declare a reversible pending UI hint,
such as disabling a row, showing "approval pending", or moving an item into a pending lane without
claiming the durable status changed.

**Acceptance criteria.**

- The UI can show pending action state before the final patch.
- Pending state is correlated to a stable client input ID.
- Failed validation/auth/write stages are visible in trace and UI.
- Reconnect can recover, dedupe, or explicitly mark in-flight actions as unknown by input ID.
- Optimistic hints roll back without corrupting projection state.
- The client does not manually mutate durable resource values as if they were authoritative.

## Stage 8 Recommended Work Order

### 1. Runtime Invocation Contract

Define an invocation-level kernel API and migrate existing runtime methods to use it internally.
The API should expose invocation input identity, protocol events, store commit operations, trace
output, and delivery intents.

This is the most important work because it clarifies several other complaints: horizontal scaling,
trace persistence, cursor allocation, observation indexing, recovery, and Bun's role as host
adapter.

### 2. Store And Coordinator Contract

Upgrade `RuntimeStore` from view snapshots plus envelope history toward a real runtime state
contract:

- atomic invocation commit
- atomic cursor allocation
- append batch semantics
- idempotency records for client input IDs
- view checkpoint load/save
- expected checkpoint version or compare-and-set writes
- envelope replay
- scoped observation-index read/write
- optional pub/sub or delivery coordination
- explicit capability metadata

Keep Memory and JSON as development adapters, but make their limitations impossible to confuse
with production durability.

### 3. Client Recovery, Input Identity, And Action Lifecycle

Make reconnect/resume real in the browser adapter. Stage 8 scope:

- automatic reconnect
- backoff with jitter
- resume from latest cursor
- client-generated input IDs
- conservative disconnected send policy (reject with typed error)

Deferred until server-side idempotency and input-ID records exist:

- input acknowledgement and action-result correlation
- input-ID-correlated lifecycle events
- explicit in-flight action behavior after disconnect
- malformed-envelope resilience
- typed `recovering` connection state
- pending input queue

This should be tested with fake sockets and fake timers.

### 4. Cursor And Multi-Writer Semantics

Define cursor meaning before adding production stores. Start with store-assigned opaque monotonic
positions for the relevant stream partition. Do not adopt HLCs or vector clocks until the project
has a concrete causality problem that monotonic store positions cannot answer.

The contract must define atomic commit and expected-version semantics now. Concurrent-write
verification (duplicate cursor allocation, stale checkpoint overwrites) should wait until a
multi-writer-capable store adapter exists. Dev stores should report their single-writer limitation
in capabilities metadata.

### 5. Invocation Auth Context And Scope

Add per-invocation identity/context through Effect before the observation index hardens. Make it
available to actions, resources, projections, and plugins without global mutable state. Include the
minimum scope data needed for resource fanout and delivery decisions.

### 6. Observation Index

Replace `listViews()` invalidation recovery with a real resource-to-view index. This should happen
before the demo adds many screens or shared resources, otherwise the wrong scaling model will hide
inside the demo. The index must be scoped by invocation/resource fanout context from the start.

### 7. Patch And Adapter Protocol

Write a minimal protocol boundary and projection/patch manifest design. Invocation tests should be
able to assert framework protocol events without depending on WebSocket or React state shapes. Only
then compare region replacement, JSON Patch, JSON Merge Patch, and UI-tree patches with real
criteria.

### 8. Demo Expansion And Optimistic UI

Expand the demo after recovery and indexing have a better base. The demo should include nested or
multi-screen layout, shared resources, a live/process resource, and action lifecycle UI. Optimistic
UI should begin as reversible pending hints, not client-owned durable state.

## Test And Acceptance Plan

Review 5 should lead to tests and spikes in these areas:

- Stateless invocation works without relying on a live registry.
- Invocation results commit envelopes, checkpoints, traces, observation writes, and input-id records
  atomically or return typed commit failures.
- Resource invalidation uses a scoped observation index with a `fanoutScope` dimension instead of
  scanning all views.
- Two runtime instances share a store and can process different views safely.
- An action handled by one runtime can deliver patches to a view attached to another runtime.
- Cursor contract defines ordering semantics and atomic commit shape.
- Client reconnects after socket close with backoff and resume cursor.
- Client inputs carry stable client-generated input IDs.
- Patch replay after reconnect produces a consistent projection.
- Unknown or malformed envelopes do not kill the reconnect loop.
- Auth identity is visible in Effect requirements and traces.
- Observation-index lookup cannot cross tenant/team/resource fanout scope.
- Invocation tests assert framework protocol events before transport/React envelope encoding.
- React adapter can apply patches through a protocol/manifest, not app-written handlers only.
- Demo proves nested layout, multiple screens, and a live/process resource.

Deferred until a multi-writer-capable store adapter exists:

- Concurrent cursor allocation remains ordered under parallel writes.
- Concurrent invocations for the same view cannot silently overwrite checkpoint state.

Deferred until input-ID protocol and server idempotency exist:

- Disconnect after send but before result has tested recover/dedupe/reject/unknown behavior.
- Client inputs have lifecycle/result envelopes correlated to their input IDs.

Existing behavior that should keep passing conceptually:

- UI events update UI state without mutating domain resources.
- Domain actions validate before mutation and invalidate typed resources.
- Failed actions do not mutate durable workflow state.
- Region-value patches update visible projection state.
- Unpatchable projection regions can fall back to full projection updates.
- Resume statuses remain explicit.
- Browser/dev trace visibility remains safe.

## Updated Contract Map

| Framework promise     | Current state                                     | Review 5 direction                                                                      |
| --------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Stateless/serverless  | Fresh-runtime wrapper over live runtime methods   | Invocation core with input identity, commit, traces, and delivery                       |
| Horizontal scaling    | Bun socket map and live registry are local        | Host/coordinator delivery intents and shared store contracts                            |
| Store consistency     | Separate cursor/envelope/checkpoint writes        | Atomic invocation commit and stale checkpoint detection                                 |
| Cursor replay         | Single-writer dev cursors                         | Store-assigned atomic cursors; concurrent-write tests deferred until multi-writer store |
| Resource invalidation | Stored observations but O(views) scan             | Scoped resource-to-view observation index with `fanoutScope` dimension                  |
| Client recovery       | Initial resume only                               | Reconnect, backoff, resume, input IDs; lifecycle/queue deferred                         |
| Patch semantics       | Region replacement plus app handlers              | Protocol boundary and manifest before JSON Patch/UI tree choices                        |
| React adapter         | Useful stream hook, app-specific projection patch | Adapter protocol with manifest-driven patch application                                 |
| Auth context          | App-provided Auth service                         | Per-invocation Effect context used by actions/resources/fanout                          |
| Resource scoping      | Program-global graph/cache                        | Scope carried into observation and delivery decisions                                   |
| Optimistic UI         | Server-confirmed updates only                     | Input-ID action lifecycle first, reversible hints later                                 |
| Demo proof            | Single approval console                           | Multi-screen/nested/live-resource operational workflow                                  |

## Bottom Line

Stage 7 made the model easier to explain. Review 5 should make the claims harder to overstate.

The project should keep saying:

```txt
Domain state is server-owned workflow truth.
UI state is view/editing context.
The program receives typed inputs.
The runtime recomputes projections and traces causality.
```

But it should be more careful with:

```txt
stateless
serverless
horizontal
adapter-agnostic
durable
```

Those words now require stronger contracts than the current code provides.

The next stage should not be "add more features." It should turn the strongest claims into
testable architecture:

```txt
stateless invocation
+ store/coordinator contracts
+ atomic commit and input identity
+ reconnecting client with in-flight semantics
+ scoped indexed observations
+ explicit protocol/adapter boundary
```

Only after that will larger demos, optimistic UI, production stores, or alternate renderers have a
solid base instead of becoming new layers of prototype debt.
