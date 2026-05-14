# Stage 7 Record

## Goal

Implement the Review 4 pivot: make Domain/UI state explicit, stop treating session as the public
state tier, and prove that the runtime can process inputs through fresh stateless invocations
using store-backed checkpoints and observations.

## Decisions Implemented

- Added `UIState` and `UIEvent` definitions as first-class framework concepts.
- Kept `Session.define` as a compatibility surface, but moved approval selection and trace-panel
  behavior to UI events.
- Added `viewId` and `ui` checkpoint fields to the live view/session runtime object while keeping
  `sessionId` and `state` compatibility fields.
- Updated screen projection typing so projection receives a `ViewContext`.
- Added `createStatelessRuntime`, which creates a fresh runtime for each connect, receive, or
  invalidation invocation.
- Made `receive` restore a checkpointed view from the runtime store when no live in-process view
  exists.
- Extended runtime stores with `listSessions()` and `supportsObservationIndex` so stateless
  invalidation can recover checkpointed views and their observed regions.
- Added program-input vocabulary types for actions, UI inputs, resource events, and system events.
- Updated README and design docs to describe Domain/UI state and stateless-capable runtime shape.

## Verification

- `bun test`: 47 tests pass.
- `bun run check`: typecheck, lint, and format check pass.

## Remaining Follow-Ups

- `Session` naming still exists for compatibility and should be deprecated gradually rather than
  removed in one breaking pass.
- Store observation recovery currently scans checkpointed views through `listSessions()`. A
  production adapter should provide indexed resource-to-view lookup.
- `createStatelessRuntime` proves invocation isolation, but Bun still uses the live runtime by
  default for the demo host.
- Program-input vocabulary is typed, but stream envelopes still use the generic `message` transport
  shape for compatibility.
