# Stage 3 Plan: Operational Resource Graph, Resume, And React Boundary

## Purpose

Stage 3 turns the approval prototype into a more serious early framework kernel without expanding into a second demo. The goal is to make resource observation operational, make reconnect/resume real enough to test, and pull the browser stream client toward a reusable React adapter.

This stage should preserve the project thesis:

```txt
browser message -> server program -> effect transaction -> resource changes
-> projection recompute -> framework stream -> React adapter -> trace
```

## Decisions

### Keep Whole Projection Updates For Now

The stream will continue to send full `projection:update` envelopes. This is intentional, not an accident.

Why:

- whole projections keep the runtime easy to reason about while the resource graph matures
- the approval demo is small enough that patch optimization is not the bottleneck
- granular patches would force a region diff format before we know the right abstraction

What changes:

- projection envelopes will include cursor and region observation metadata
- named projection regions will exist as runtime metadata
- invalidated resources can be mapped to observed sessions and regions

What remains skipped:

- no `projection:region:update` envelope yet
- no JSON Patch protocol
- no React Flight/RSC payloads
- no DOM or component-tree patching

### Add Named Projection Regions Without Region Patches

Projection code can mark parts of projection work with region IDs such as:

- `pendingDeployments`
- `selectedDeployment`
- `tracePanel`

The runtime records which resources each region reads. Reads outside a region are recorded under `root`.

Why:

- region observation is the bridge from full projections to future partial patches
- resource invalidation becomes explainable in framework terms
- tests can prove resource graph behavior without depending on approval-demo internals

### Add Resume Through Store Interfaces

Reconnect/resume should be real enough to use, but persistence should not be hardcoded as files.

This stage will add a runtime store boundary:

- `MemoryRuntimeStore` as the default
- `JsonFileRuntimeStore` as a dev/test adapter

The store persists framework runtime data:

- session snapshots
- projection cursors
- stream envelope history
- observed regions

It does not become the app database. Durable business truth still belongs to app services/resources.

### Make The React Client Adapter Generic

The current browser stream client is approval-specific. This stage will extract a reusable client adapter that can:

- connect to a route with params
- store `sessionId` and cursor in `sessionStorage`
- resume when possible
- dispatch typed framework messages
- surface projections, traces, action results, and errors to React

The approval app will use this generic adapter.

### Add One Local React Island

The demo should prove that ordinary React state can exist without owning workflow truth.

Add a small local-only island to the approval UI, such as a pending-deployment filter. It must not call the server, mutate durable state, or become a client cache.

## What This Stage Will Not Build

- production database persistence
- cross-process distributed session storage
- multiple screens or file routing
- region patch envelopes
- React Flight/RSC integration
- a second workflow scenario
- optimistic UI
- authorization/auth product primitives
- framework CLI or Bun plugin integration

## Test Direction

Tests should stay contract-first:

- framework behavior should be tested with small fake programs
- approval tests should remain demo acceptance coverage
- tests should describe observable runtime behavior, not private helper implementation

Required coverage:

- region/resource observations are recorded during projection
- invalidated resources can be mapped to affected sessions and regions
- valid resume restores session state and emits a fresh projection
- invalid resume falls back or errors in a predictable way
- memory and JSON-file stores satisfy the same runtime-store contract
- generic client adapter resume state can be tested without tying behavior to approval internals

## Completion Criteria

- `bun test` passes
- `bun run format` has been run
- `bun run check` passes before each implementation commit
- approval demo still works in the browser
- refresh/reconnect can restore session state in the demo
- traces and projection envelopes expose cursor and region observation data
