# Framework State Review 4

## Purpose

This report audits the framework after Stage 6 and sets the Stage 7 direction. It is a
decision review, not an implementation patch.

Review 3 asked whether the implementation was honest enough to become a framework kernel.
Stage 6 answered much of that: Effect is now native, schemas/routes/actions/sessions are backed by
builders, plugins exist, stores expose capabilities, host/renderer/demo boundaries are cleaner,
and React adapter state is grouped.

Review 4 asks a different question:

```txt
Does the framework now have the right conceptual model to be understandable,
serverless-first, and still meaningfully different from normal client/server apps?
```

The answer is: not yet. The current code proves the loop, but the state model and input
vocabulary still create friction. Stage 7 should be the pivot toward a stricter two-tier state
model and a stateless invocation kernel.

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
- `docs/framework-state-review-3.md`
- `docs/stage-4-record.md`
- `docs/stage-5-record.md`
- `docs/stage-6-record.md`
- `src/framework/*`
- `src/adapters/react/*`
- `src/demo/approvals/*`
- `tests/*`
- `README.md`

## Current Verification State

- Worktree was clean before this report was added.
- `bun test` passes: 42 tests.
- `bun run check` currently fails only on `oxfmt --check`, which reports formatting differences
  across existing docs/source/tests.

This matters because `docs/stage-6-record.md` says `bun run check` passed at Stage 6 completion.
That was true for that recorded point, but the current working tree is no longer check-clean. Stage
7 should start by running the formatter or intentionally recording why formatting is deferred.

## Executive Summary

The Stage 6 framework is real enough to expose the next problem clearly.

The core loop works:

```txt
browser envelope
-> runtime
-> action or session update
-> Effect work
-> resource invalidation
-> projection recompute
-> region-value patch
-> React adapter
-> trace
```

But the public mental model is now under pressure in three places:

- There are too many state-like concepts: resources, session state, runtime store snapshots,
  live-session registry, stream cursor state, trace state, and React local state.
- The runtime still centers an in-process object model even though the project wants a
  stateless/serverless story.
- "Message" is too broad as public vocabulary, while "Action" is too narrow for everything that
  can enter the program.

Stage 7 should make these decisions:

```txt
Domain state + UI state
not
resources + sessions + local state + runtime snapshots + maybe client state
```

```txt
stateless program invocation
not
long-lived server object as the primary architecture
```

```txt
Action / UIEvent / ResourceEvent / SystemEvent
not
one vague Message concept for every input
```

The important part is not naming polish. These decisions determine where state can live, what can
mutate durable truth, what must be traced, what serverless adapters must implement, and which
concept a developer reaches for first.

## Current State Model Audit

### Domain Resources

Current evidence:

- `ResourceGraph` registers resource definitions and reads typed keys.
- Actions invalidate resource keys.
- Projection regions record observed resources.
- Runtime invalidation maps resource keys to observed regions and emits region-value patches.

Grade: **solid foundation**.

Resources are the strongest state concept in the framework. They are authoritative enough to
explain the architecture: durable workflow truth is read through resources, actions invalidate
resources, and projections update from resource changes.

Remaining problem: resources are still mostly loader-plus-cache definitions. That is acceptable
for now. The bigger issue is not resource power; it is that non-domain state is not modeled with
the same conceptual care.

### Session State

Current evidence:

- `SessionDefinition` defines `init`, `accepts`, and `update`.
- Approval session state stores `selectedDeploymentId` and `tracePanelOpen`.
- `SessionSnapshot` persists route, params, state, projection version, cursor, and observed
  regions.
- `LiveSessionRegistry` owns process-local active sessions.

Grade: **useful implementation scaffold, wrong public center**.

Session state was the correct early prototype move. It proved per-tab conversation state and
resume. But it now carries at least three responsibilities:

- UI state, such as selected deployment and trace panel openness.
- View/runtime context, such as route, params, projection version, cursor, and observations.
- Live process attachment, through `LiveSessionRegistry` and host socket delivery.

Those are not the same concept. Keeping them under "session" makes the framework look like it has
three state tiers:

```txt
resources
+ sessions
+ client/local state
```

That is exactly the confusion Stage 7 should remove.

### React Local State

Current evidence:

- The approval app keeps `deploymentFilter` in React `useState`.
- That filter is not a resource, not session state, not persisted, and not traced.

Grade: **correct behavior, unofficial model**.

The local filter is valuable evidence. It shows that ordinary UI state should exist and that not
every dropdown, text draft, or filter belongs on the server.

The problem is that the framework has no official explanation for this. If documentation says
"all UI is a server projection" while the demo uses local React state, the model looks leaky. The
right answer is not to ban local state. The right answer is to define a UI state tier with clear
placement rules.

### Runtime Store State

Current evidence:

- `RuntimeStore` persists session snapshots and stream envelopes.
- Memory and JSON stores expose capability metadata.
- Stores do not own domain data; approval services still own deployment/audit truth.

Grade: **good runtime infrastructure, easy to misread**.

Runtime store state is framework recovery state. It should not be treated as a third application
state tier. Its job is to checkpoint view context, UI resume state, stream cursors, observations,
and envelope history.

Stage 7 should rename and shape store contracts around those responsibilities. "Session snapshot"
should become more explicit:

```txt
view checkpoint
  route + params
  ui checkpoint
  cursor
  observed regions/resources
  protocol/schema versions
```

### Live Session Registry

Current evidence:

- `LiveSessionRegistry` is a process-local `Map`.
- Runtime `connect` creates or restores an active session in memory.
- Bun host owns socket delivery maps separately.

Grade: **valid live-host optimization, not serverless foundation**.

This is the main serverless conflict. The current runtime can restore from a store, but the primary
execution shape is still "create runtime, keep registry, process messages against live session
objects."

That is fine for the Bun adapter. It cannot remain the primary kernel model if serverless is the
main pitch.

### Trace State

Current evidence:

- `TraceStore` is in-memory.
- Browser/dev visibility exists.
- Traces are scoped to sessions and emitted through stream envelopes.

Grade: **useful causal layer, not state tier**.

Trace is not domain state and not UI state. It is observability over causality. Stage 7 should
preserve the trace advantage while admitting that UI-only state does not require the same trace
weight as domain mutation.

The rule should be:

- Domain actions produce durable causal traces.
- UI events may produce lightweight view traces when they cross the program boundary.
- Local-only UI state can be inspected by adapter/devtools, but it should not pretend to be a
  server transaction.

## State Model Decision

Stage 7 should adopt two public state tiers:

```txt
Domain state
UI state
```

`Session` should stop being presented as a state tier. It becomes a runtime/view carrier used by
hosts and stores.

### Why Not Keep Server Session As The UI State Model?

The current model is attractive because it preserves the beautiful early thesis:

```txt
browser event -> server program -> projection -> trace
```

If every selected row, dropdown, draft, and panel flag lives in a server session, the server can
explain everything.

But this breaks down as the default model:

- It is the hardest part to sell. Developers expect cheap transient UI behavior.
- It makes serverless harder because every minor UI interaction wants a store write or server
  invocation.
- It invites false durability: a dropdown being open is not application truth.
- It makes normal React components feel suspect even when they are doing harmless local UI work.

Server-owned UI state is still useful for some cases, but it should not be the default public
answer.

### Why Not Make UI State Purely Local And Ignore The Server?

Pure local UI state fits serverless and developer expectations. It handles dropdowns, filters,
menus, text drafts, tabs, and transient affordances without ceremony.

But if pushed too far, it weakens the framework:

- Server projections may depend on selected UI context, such as selected deployment detail.
- Resume may need view state restored.
- Causal traces become incomplete if action inputs are silently pulled from untracked client
  state.
- Client-local state can slide into client cache ownership if the boundary is vague.

So local-first is the right pressure, but not enough by itself.

### Why Not Expose A Large Hybrid Taxonomy?

A richer taxonomy is technically accurate:

```txt
local-only UI
checkpointed UI
server-projected UI
collaborative UI
domain state
runtime state
trace state
```

The problem is public complexity. If Stage 7 exposes all of that as first-class vocabulary, the
framework will feel harder than the problem it solves.

The better move is:

- Expose two public tiers: Domain and UI.
- Define internal/advanced policies for UI state.
- Give clear promotion rules.

### Decision: Local-First UI Tier With Checkpoints And Promotion Rules

The UI tier should be local-first by default.

That means:

- UI state can live in the renderer/client without entering the server program.
- UI state can be sent to the program through `UIEvent` when a server projection depends on it.
- UI state can be checkpointed for resume when the app asks for that.
- UI state must not be treated as durable workflow truth.

The placement rule:

```txt
If losing it only changes presentation, it is UI state.
If losing it corrupts workflow truth, permissions, sharing, audit, or durable process state,
it is domain state.
```

Promotion rule:

```txt
When UI state becomes product truth, promote it to domain state.
```

Examples:

| State                      | Tier               | Reason                                        |
| -------------------------- | ------------------ | --------------------------------------------- |
| Dropdown open              | UI                 | Pure presentation                             |
| Search/filter text         | UI                 | Presentation unless it creates a saved search |
| Selected deployment row    | UI                 | View context; may be checkpointed for resume  |
| Unsaved form draft         | UI                 | UI until autosaved/submitted/shared           |
| Deployment approval status | Domain             | Workflow truth                                |
| Incident owner             | Domain             | Shared and permissioned workflow truth        |
| AI run progress            | Domain             | Durable process state                         |
| Trace panel open           | UI                 | Presentation/debug preference                 |
| Browser connection state   | UI                 | Adapter-local runtime status                  |
| Stream cursor              | Runtime checkpoint | Recovery state, not app state                 |

This is not an escape hatch. It is the other half of the model:

```txt
Domain state is what the program knows is true.
UI state is how a viewer is currently looking at or editing that truth.
```

## UI State Contract

Stage 7 should define UI state through behavior, not only storage location.

### UI State Must Not Mutate Domain Directly

A UI event may change UI state and trigger projection recomputation. It must not perform durable
domain writes.

For example:

```txt
UIEvent deployment.select
-> update selectedDeploymentId in UI checkpoint
-> project selected deployment detail
-> stream region patch
```

Approving a deployment is different:

```txt
Action deployment.approve
-> validate action input
-> run auth/permission/effects
-> write deployment status
-> invalidate resources
-> stream patches
```

This distinction gives developers a concrete answer:

- Use `UIEvent` when the user changes view/editing context.
- Use `Action` when domain truth may change.

### UI State Can Be Local, Checkpointed, Or Projected

The public tier is "UI", but the implementation needs policy levels:

| Policy       | Behavior                                               | Example                         |
| ------------ | ------------------------------------------------------ | ------------------------------- |
| Local-only   | Lives only in the renderer; no server trace/store      | Dropdown, hover, unsaved filter |
| Checkpointed | Stored for resume as UI checkpoint                     | selected row, open panel        |
| Projected    | Sent with a `UIEvent`; server projection depends on it | selected deployment detail      |

These are policies, not separate public state tiers.

The approval demo should become the canonical example:

- `deploymentFilter`: local-only UI state.
- `selectedDeploymentId`: projected/checkpointed UI state because it changes server-projected
  detail.
- `tracePanelOpen`: checkpointed UI state or local-only debug preference, depending on what the
  demo wants to prove.
- deployment approval status: domain state.

### UI State Must Be Explicit When Used By Actions

An action must not implicitly read hidden client UI state.

If an action needs the selected deployment, the action input should include `deploymentId`, or the
server should read an explicit checkpointed UI value and trace that read. The recommended default
is explicit action input.

This prevents a common failure mode:

```txt
client has selected A
server checkpoint has selected B
user clicks approve
wrong deployment is approved
```

The action input is the contract. UI state may help fill the input, but it is not domain authority.

### UI Events Should Preserve Causal Traces Without Pretending To Be Domain Actions

UI events that cross the program boundary should still be traceable:

```txt
UIEvent deployment.select
-> UI checkpoint updated
-> selectedDeployment region recomputed
-> patch streamed
```

But they should not look like domain transactions. The trace phase should distinguish:

- `ui`
- `action`
- `resource`
- `projection`
- `stream`

This keeps the causal trace system strong without forcing every local interaction into the heavy
action path.

## Stateless Serverless Decision

Stage 7 should make stateless invocation the primary runtime contract.

The current runtime is shaped like this:

```txt
createRuntime(program)
-> keep ResourceGraph cache
-> keep LiveSessionRegistry
-> keep TraceStore
-> receive messages over time
```

The target shape should be:

```txt
Program manifest
+ invocation input
+ store/coordinator adapters
-> pure-ish invocation result
   envelopes
   store writes
   delivery intents
   trace events
```

The runtime can still use effects and adapters. "Stateless" does not mean no persistence. It means
the kernel must not require process memory to be correct.

### Why This Must Be A Hard Constraint

Serverless cannot be treated as a later adapter detail because it changes the model:

- UI checkpoints cannot assume live process memory.
- Resource observation indexes need a durable or coordinator-backed place if fanout matters.
- Stream replay and projection baselines need retention semantics.
- Live sockets are host/coordinator concerns, not kernel state.
- Resource caches are per-invocation optimizations unless backed by an adapter.

If Stage 7 keeps live server sessions as the conceptual center, every later serverless adapter will
be forced to emulate a long-lived server process. That is the wrong direction for this project.

### What Stays Store-Agnostic

The review should not pick SQLite, Redis, Cloudflare Durable Objects, Workers KV, D1, memory, or
anything else as the blessed store.

The framework should define contracts:

- view checkpoint load/save
- stream envelope append/replay
- observed resource index read/write
- cursor allocation or monotonic ordering
- optional pub/sub or delivery coordination
- retention and compaction
- corruption/version failure behavior

Adapters can satisfy those contracts differently.

### Runtime Responsibilities After The Pivot

The kernel should own:

- decoding program inputs
- loading view checkpoints when required
- running UI events and actions
- reading resources through effects
- recomputing projections/regions
- producing envelopes and traces
- returning store writes and delivery intents

The host/coordinator should own:

- HTTP/WebSocket request mechanics
- live connection registry
- fanout to connected clients
- serverless platform bindings
- background/timer triggers

The store should own:

- checkpoint durability
- envelope history
- observation index, if the adapter supports live fanout
- retention and compaction

### Bun Becomes A Host Adapter Over Stateless Invocation

Bun should remain the first local development host. It is useful and working.

But after Stage 7, Bun should wrap the stateless kernel:

```txt
Bun socket message
-> build invocation input
-> call ProgramRuntime.invoke(...)
-> persist returned writes
-> deliver returned envelopes by session/view id
```

`LiveSessionRegistry` can still exist as a live-host cache or compatibility layer. It should not be
the required runtime truth.

## Input Vocabulary Decision

The current stream has a generic client envelope:

```txt
{ type: "message", sessionId, message: { type: string, ... } }
```

The runtime then checks:

```txt
is this an action type?
else is this accepted by session?
else reject
```

This was a good prototype dispatch strategy. It is not a good public vocabulary.

### Why Not Make Everything An Action?

"Action" is a strong public word. It reads like a domain transaction.

That is good for:

- `deployment.approve`
- `incident.claim`
- `agent.cancelRun`
- `case.assignOwner`

It is bad for:

- open dropdown
- select row
- toggle trace panel
- update unsaved draft text
- reconnect
- resource invalidated externally

If every input is an action, either actions become too weak, or UI events become too heavy.

### Why Not Use Command/Event As The Main Vocabulary?

Command/event split is defensible:

- command: request to do something
- event: something that happened

The problem is that it pulls the project toward event-sourcing vocabulary before the framework has
chosen event sourcing. It also risks making UI state harder to explain:

- Is selecting a row a command or event?
- Is an external invalidation an event?
- Is a browser click a command?
- Is an action a command handler?

This vocabulary may be useful internally later, but it should not be the first public mental model.

### Decision: Program Inputs With Typed Subtypes

Stage 7 should use "program input" as the conceptual umbrella and keep "message" as transport
language.

Public subtypes:

| Input type      | Purpose                               | Can mutate domain?              |
| --------------- | ------------------------------------- | ------------------------------- |
| `Action`        | Domain transaction                    | Yes                             |
| `UIEvent`       | View/UI state transition              | No                              |
| `ResourceEvent` | External resource change/invalidation | No direct write; reports change |
| `SystemEvent`   | Connect, resume, timer, lifecycle     | Runtime-controlled              |

This is not naming for its own sake. The subtype controls:

- validation path
- mutation permission
- trace phases
- persistence behavior
- replay behavior
- adapter dispatch
- developer guidance

The stream can still carry a message envelope:

```txt
ClientEnvelope.message
```

But app authors should think in program inputs:

```ts
Action.define("deployment.approve");
UIEvent.define("deployment.select");
ResourceEvent.define("deployment.changed");
```

## Public API Direction

The current API should not be replaced in one large rewrite. Stage 7 should introduce the new
model behind compatibility and then migrate the approval demo.

### View Context

Introduce a view-level runtime concept that replaces session as the public mental model:

```txt
ViewContext
  viewId
  route
  params
  cursor
  ui checkpoint
  observed regions/resources
```

This is what the runtime restores and checkpoints. It can be implemented using today's session
snapshot machinery at first.

### UI State Definition

Illustrative shape:

```ts
const approvalUi = UIState.define("approval.ui")
  .state(ApprovalUIState)
  .init(() => ({
    selectedDeploymentId: null,
    tracePanelOpen: true,
  }))
  .event("deployment.select", SelectDeployment, (state, event) => ({
    ...state,
    selectedDeploymentId: event.deploymentId,
  }))
  .event("trace.toggle", ToggleTracePanel, (state) => ({
    ...state,
    tracePanelOpen: !state.tracePanelOpen,
  }));
```

This should replace the public role currently played by `Session.define`.

### Screen Projection

Projection should receive UI state explicitly:

```ts
project({ params, ui }, context);
```

instead of receiving a broad session object whose fields mix route params, runtime cursor, observed
regions, and UI state.

The projection model becomes:

```txt
route params + UI state + observed domain resources -> projection
```

That is the precise version of the two-tier model.

### Actions

Actions stay domain-oriented:

```ts
Action.define("deployment.approve");
```

Rules:

- actions validate input
- actions run Effect transactions
- actions may mutate domain state
- actions invalidate resources
- actions produce domain causal traces
- actions do not update UI state as a hidden side effect

If an action result should change UI state, that should be modeled as an explicit returned event,
client handling rule, or follow-up UI event. Do not hide UI mutation inside action execution.

### Resource Events

`runtime.invalidate(keys)` exists today and should become part of a clearer `ResourceEvent` lane.

Examples:

- database notification says deployment changed
- queue says AI run progressed
- timer says resource should refresh
- external integration reports incident event

The resource event should trigger projection recomputation for affected views without pretending a
user action occurred.

### System Events

Connect/resume should stop feeling like app messages. They are system inputs:

```txt
SystemEvent.connect
SystemEvent.resume
SystemEvent.disconnect
SystemEvent.timer
```

Apps may hook them through plugins, but they are not domain actions or UI events.

## Stage 7 Recommended Work Order

### 1. Restore Repo Hygiene

Run the formatter and make `bun run check` pass again. This should be done before deep changes so
future diffs are meaningful.

### 2. Add Review 4 To The Docs Index

Link this review from the design index and treat it as the Stage 7 planning source.

### 3. Introduce UI State And UI Events Behind Compatibility

Add UI state definitions and UI event dispatch while keeping `Session.define` as a compatibility
surface.

Acceptance target:

- approval selection and trace panel behavior can be expressed as UI events
- domain approval remains an action
- local filter remains ordinary React local UI state

### 4. Split Session Into View Context Pieces

Refactor current session responsibilities into explicit roles:

- view identity
- route and params
- UI checkpoint
- projection cursor/version
- observed regions/resources
- live delivery attachment

Keep storage compatibility if practical, but update names and tests around the new model.

### 5. Add Stateless Invocation Core

Introduce a runtime entrypoint shaped around one invocation:

```txt
invoke(program, input, adapters) -> invocation result
```

The result should include:

- envelopes to emit
- store writes to persist
- delivery intents
- trace snapshots/events
- resource invalidations or observation updates

This does not need to be perfectly pure internally. It does need to make process memory optional.

### 6. Make Bun Runtime Wrap The Invocation Core

Keep the existing demo working through Bun, but make the host call the stateless invocation path.

`LiveSessionRegistry` should become optional live-host acceleration, not the source of truth.

### 7. Extend Store Contracts For View Checkpoints And Observation Indexes

Runtime stores should evolve from session/envelope persistence toward:

- view checkpoints
- UI checkpoint schemas
- envelope replay
- observation index by resource key
- retention and compaction
- adapter capability metadata

Memory and JSON can remain dev adapters.

### 8. Update Traces For Input Subtypes

Trace phases should distinguish:

- `ui`
- `action`
- `resource`
- `system`
- `projection`
- `stream`

Browser-safe trace filtering must remain.

### 9. Rewrite Public Docs Around The New Vocabulary

README and design docs should explain:

- Domain vs UI state
- Action vs UIEvent vs ResourceEvent vs SystemEvent
- serverless/stateless primary runtime
- Bun as first host adapter
- stores as adapter contracts, not a chosen product

## Test And Acceptance Plan

### State Tier Tests

- UI event updates UI state and projection without domain resource invalidation.
- Domain action mutates domain state and invalidates resources without hidden UI mutation.
- Local-only UI state remains outside runtime store and server trace.
- Checkpointed UI state resumes in a fresh runtime instance.
- UI state used by an action must be explicit action input or an explicit checkpoint read in trace.

### Stateless Runtime Tests

- Connect can produce a projection through a single invocation without a live registry.
- UI event can restore checkpoint, update UI state, recompute projection, and persist a new
  checkpoint.
- Action can run in a fresh runtime invocation and fan out patches using stored observations.
- Resource event can refresh affected views without an initiating browser socket.
- Missing checkpoint, stale cursor, route mismatch, and corrupt checkpoint return typed outcomes.

### Store Contract Tests

- Memory and JSON adapters satisfy view checkpoint load/save.
- Store capabilities state whether observation indexes and pub/sub are supported.
- Corrupt UI checkpoint state is reported as typed store failure.
- Replay can provide a projection baseline before patch-only history.

### Vocabulary Tests

- Unknown `Action` type is rejected as an action failure, not treated as a UI event.
- Unknown `UIEvent` type is rejected as a UI event failure, not treated as an action.
- `ResourceEvent` cannot execute action handlers.
- `SystemEvent` dispatch is available to runtime/plugin hooks without becoming public app action
  traffic.

### Regression Tests To Preserve

- Approval action success/failure semantics.
- Failed actions do not mutate domain state.
- Region-value patches update visible projection state.
- Unpatchable regions fall back to full projection updates.
- Resume statuses remain explicit.
- Host delivery can route envelopes to connected sessions/views.
- Browser/dev trace visibility remains safe.

## Updated Contract Map

| Framework promise       | Current state                                         | Stage 7 decision                                     |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Durable workflow truth  | Resources and actions                                 | Keep as Domain state                                 |
| UI/conversational state | Session state plus React local state                  | Make UI state a first-class tier                     |
| Session                 | State, route, cursor, observations, live object       | Reframe as ViewContext/runtime carrier               |
| Client local state      | Exists unofficially                                   | Officially valid for local-only UI                   |
| Serverless              | Resume works, runtime still process-centered          | Stateless invocation becomes kernel contract         |
| Runtime store           | Session snapshots and envelope log                    | View checkpoints, envelopes, observations, retention |
| Live delivery           | Bun socket registry                                   | Host/coordinator responsibility                      |
| Message                 | Transport and public concept are blurred              | Message is transport; program inputs are typed       |
| Action                  | Domain transaction but competes with session messages | Keep only for domain mutation intent                 |
| UI event                | Currently session message                             | First-class input subtype                            |
| Resource event          | `runtime.invalidate()`                                | First-class external invalidation lane               |
| System event            | Connect/resume envelopes                              | Runtime input subtype                                |
| Trace                   | Strong for actions, mixed for session updates         | Distinguish UI/action/resource/system causality      |

## Bottom Line

Stage 6 made the framework more architecturally honest. Stage 7 should make it easier to
understand and easier to deploy.

The project should not sell "no client state." That is too brittle and too hard to adopt.

It should sell a stricter and better model:

```txt
Domain state is server-owned workflow truth.
UI state is view/editing context.
The program receives typed inputs.
The stateless kernel recomputes projections and traces causality.
Hosts and stores provide deployment-specific durability and delivery.
```

That preserves the original thesis without forcing every transient interaction through a server
session:

```txt
Build webapps as durable server programs,
with explicit UI state instead of accidental client/server glue.
```

Stage 7 should implement this pivot before adding another demo slice, a production store adapter,
or a renderer/UI-tree experiment.
