# Framework State Review 7

## Purpose

This review records the Stage 10 semantic hardening direction. It is a design and
documentation pass, not a runtime implementation pass.

The project has working pieces now: resources, actions, UI state, screens, region-value patches,
navigation, optimistic overlays, traces, stores, and a Bun host. The next risk is not missing one
more feature. The next risk is letting the public model stay too broad:

```txt
server state + UI state + React state + protocol state
```

If those words are not stricter, the framework can look like another way to spread application
state across boundaries. Stage 10 narrows the idea:

```txt
Effect-native workflow UI runtime for durable server programs.
```

The browser is not "just a terminal" as a technical claim. It is a renderer and adapter. The
server program owns workflow behavior, resources, server-observed view context, effects, and
traces. Renderer state is allowed, but it is outside the program and must be disposable.

## Decision 1: Lead With Workflow Programs

### Decision

The public pitch should center on workflow-heavy apps built as durable server programs with live
projections and causal traces.

Prefer:

```txt
Build workflow-heavy web apps as durable server programs with live projections and causal traces.
```

Avoid:

```txt
No API layer.
The browser is only a terminal.
You do not write a frontend and backend.
```

### Why

"No API layer" is emotionally clear but technically weak. The framework still has a stream
protocol, input envelopes, actions, projections, patches, and adapter contracts. The better claim
is narrower and true:

```txt
No handwritten request/response API layer for app state.
```

The real enemy is not the existence of a client/server boundary. The enemy is workflow state spread
across React state, client caches, API handlers, background job polling, WebSocket glue, and logs.

The strongest loop remains:

```txt
typed input
-> Effect transaction
-> resource invalidation
-> projection recomputation
-> streamed patch/update
-> causal trace
```

Traces should be described as a core value proposition. They are not just debug polish. The
framework should make it normal to ask "why did this UI change?" and get an input-to-patch answer.

## Decision 2: Program-Owned Vs Renderer-Owned State

### Decision

Use two ownership domains:

```txt
Program-owned state
Renderer-owned state
```

Do not present domain state, UI state, and local React state as three equal application-state tiers.

### Program-Owned State

Program-owned state is visible to the server program. It can affect projection, resume,
authorization, sharing, collaboration, traces, or workflow decisions.

It has two main app-level forms:

- Domain resources and actions: durable workflow truth.
- `UIState` and view checkpoints: server-observed view/editing context.

Examples:

- deployment approval status
- audit entries
- incident owner
- selected deployment when the server reads selected detail
- active trace panel mode when resume/debug policy depends on it
- route and params

### Renderer-Owned State

Renderer-owned state lives outside the program. It may use React state, DOM state, third-party
widget internals, or adapter-local bookkeeping. It must be disposable.

It is only valid when losing it cannot affect:

- projection correctness
- resume behavior
- authorization or permissions
- sharing or collaboration
- traceability
- workflow truth
- server-side resource reads

Examples:

- focus bookkeeping
- element measurement
- hover state
- pointer drag position before commit
- animation phase
- uncontrolled input composition before commit
- client-only disclosure state whose loss does not alter the program

### Protocol State

Protocol state is neither app truth nor renderer-owned UX state. It exists to make the adapter and
runtime communicate.

Examples:

- optimistic projection overlays
- pending client input IDs
- stream cursors
- reconnect state
- action lifecycle status

Optimistic UI remains a temporary projection overlay tied to a typed input. It is confirmed or
rolled back by server projection, action result, and trace behavior. It must not become a third app
state store.

### Demo Consequence

The approval demo currently routes `deploymentFilter` through `UIState` while presenting it as a
local filter. That is an ambiguous teaching example. The next implementation pass should remove it
from the demo or replace it with a clearer local renderer-only interaction.

## Decision 3: First-Class Resource Cache Scope

### Problem

Current resource identity is effectively:

```txt
resource type + id
```

That is not enough for permission-shaped resources. If `PendingDeployments(teamId)` returns
different values for different principals, caching only by `teamId` can leak or reuse the wrong
projection data.

Fanout scope and cache scope are related but not identical:

- Fanout scope answers: which connected views may receive this invalidation or patch?
- Cache scope answers: does this resource key mean the same value for this reader?

Both matter. Fanout scope prevents cross-audience delivery. Cache scope prevents cross-audience
value reuse.

### Decision

Add declaration-level resource scope as the target design.

Default scope:

```txt
global
```

Built-in target scopes:

- `global`: same value for every reader.
- `fanout`: value varies by the current fanout scope, such as team or tenant.
- `principal`: value varies by the current principal; missing principal resolves to an explicit
  anonymous scope.
- `custom`: value varies by an app-defined function of invocation context and resource params.

Scoped resource identity should be:

```txt
resource type + base id + resolved scope
```

The base id remains the domain identity authors invalidate. The resolved scope is runtime/cache
identity.

### Trace Policy

Browser-safe traces should show enough scope information to debug causality without exposing raw
principal or secret scope tokens. Dev traces may include fuller scope diagnostics.

## Decision 4: Broad Invalidation First

### Decision

For scoped resources, invalidating a base resource key should refresh all observed scopes for that
base resource identity.

Example:

```txt
invalidate PendingDeployments(team-platform)
-> refresh PendingDeployments(team-platform) in every observed principal/fanout/custom scope
```

### Why

Action authors usually know which domain resource changed. They often do not know every viewer,
principal, or scope that may have observed a permission-shaped variant.

Broad invalidation favors correctness over precision. Exact-scope invalidation can come later as
an optimization for high-volume resources.

This is similar in spirit to TanStack Query's invalidation model, where invalidation can match a
broad query-key prefix or a more specific key. The first framework contract should make the broad
case easy and correct before exposing exact-scope precision.

Reference: [TanStack Query Invalidation](https://tanstack.com/query/latest/docs/react/guides/query-invalidation).

## Comparative Notes

### TanStack Query

TanStack Query validates the idea that broad invalidation is a practical default. It lets callers
invalidate multiple queries by partial key matching and become more specific when needed.

This framework should borrow the correctness intuition, not the client-cache architecture. The
server program still owns resources, invalidation, projection recomputation, and traces.

### Phoenix LiveView

Phoenix LiveView is the strict server-state comparison point. LiveView keeps view assigns on the
server and sends events/diffs across the connection.

References:

- [LiveView Assigns](https://hexdocs.pm/phoenix_live_view/assigns-eex.html)
- [LiveView Bindings](https://hexdocs.pm/phoenix_live_view/bindings.html)

This project should learn from LiveView's clarity without copying a "server owns every interaction"
rule into a React adapter. Renderer-owned state remains valid when the program cannot observe it.

### React Server Components

React Server Components preserve a real server/client split. Server-rendered data and client
components can coexist, and client components can still own local interaction state.

Reference: [React Server Components](https://react.dev/reference/rsc/server-components).

This supports the Stage 10 framing: renderer-owned state is not a betrayal of the model. It is
outside the program boundary.

## Future Validation Scenarios

The next implementation stage should cover these scenarios:

- Two principals read the same resource base key with different permissions and do not share
  cached values.
- An action invalidates a base resource key and refreshes all observed scoped variants.
- A principal-scoped resource without a principal uses an explicit anonymous scope.
- A local renderer-only interaction is allowed only when losing it cannot affect projection,
  resume, authorization, sharing, traceability, or workflow truth.
- The approval demo no longer teaches "local filter through server UIState" as an example.

## Tracked Next Directions

Stage 10 does not implement these, but they remain the next runtime pressure points:

- in-flight input recovery after disconnect
- patch-apply failure recovery through full projection refresh
- resource/region/trace devtools
- exact-scope invalidation as a later optimization
- resource scope contract tests and demo cleanup

## Bottom Line

The sharper model is:

```txt
The app is a durable server program.
Resources/actions own workflow truth.
UIState owns server-observed view/editing context.
Renderer state is disposable and outside the program.
Protocol state is adapter machinery, not app truth.
Resource cache identity must include scope when values vary by audience.
Base-key invalidation refreshes all observed scopes first.
Every meaningful input should be traceable from cause to projection.
```
