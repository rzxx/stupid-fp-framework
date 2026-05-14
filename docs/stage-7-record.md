# Stage 7 Record

## Goal

Implement the Review 4 pivot: make Domain/UI state explicit, stop treating session/view runtime
carriers as a public state tier, and prove that the runtime can process inputs through fresh stateless invocations
using store-backed checkpoints and observations.

## Decisions Implemented

- Added `UIState` and `UIEvent` definitions as first-class framework concepts.
- Removed the old `Session.define`/`view.define` compatibility surface. Programs now declare
  `uiState` directly.
- Replaced the live view/session runtime object with `ViewContext` and `ViewCheckpoint`.
- Updated screen projection typing so projection receives a `ViewContext`.
- Added `createStatelessRuntime`, which creates a fresh runtime for each connect, receive, or
  invalidation invocation.
- Made `receive` restore a checkpointed view from the runtime store when no live in-process view
  exists.
- Extended runtime stores with `listViews()` and `supportsObservationIndex` so stateless
  invalidation can recover checkpointed views and their observed regions.
- Replaced the old stream `message` envelope with a stream `input` envelope.
- Added program-input vocabulary types for actions, UI inputs, resource events, and system events.
- Updated README and design docs to describe Domain/UI state and stateless-capable runtime shape.

## Verification

- `bun test`: 47 tests pass.
- `bun run check`: typecheck, lint, and format check pass.

## Remaining Follow-Ups

- Store observation recovery currently scans checkpointed views through `listViews()`. A
  production adapter should provide indexed resource-to-view lookup.
- `createStatelessRuntime` proves invocation isolation, but Bun still uses the live runtime by
  default for the demo host.
