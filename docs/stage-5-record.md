# Stage 5 Record

## Goal

Move the Stage 4 runtime from region invalidation metadata toward real streamed UI update behavior, while keeping the long-term renderer/UI-tree direction open.

This stage does not implement React Flight or a full framework UI tree. It establishes the patch and delivery contracts needed before that larger adapter spike can be done honestly.

## Decisions

- Region-value patches are the first real patch contract.
- `projection:update` remains a recovery/fallback envelope while patch behavior matures.
- Patch payloads must carry enough data for a client adapter to update visible projection state.
- Host delivery must route envelopes by target `sessionId`, not only respond to the initiating socket.
- Client stream tests should use injected WebSocket/storage dependencies instead of depending on the approval demo.
- Renderer/UI-tree or Flight-style patches remain the strongest long-term direction, but they should build on this stream/delivery foundation rather than replace it blindly.

## Progress

- Added region values to projection region snapshots when the region returns JSON-compatible data.
- Changed `projection:patch` to carry `region-values` with `projectionVersion`, resources, and replacement values.
- Updated approval screen regions so pending deployments, selected deployment, and trace panel values are patchable projection values.
- Added a generic client-side region patch applier and wired the approval React adapter to use it.
- Changed runtime invalidation so action-triggered invalidations return envelopes for every affected session.
- Added Bun host session-to-socket delivery so returned envelopes are sent to their target browser sessions.
- Added trace events for streamed region patches.
- Made the browser stream client injectable for WebSocket and storage, enabling implementation-light client contract tests.
- Fixed React trace merging so live trace updates are not clobbered or reordered by projection-derived trace snapshots.
- Changed normal runtime updates to patch-first behavior:
  - session messages now emit `projection:patch`
  - successful action/resource invalidations emit `projection:patch`
  - failed actions do not emit projection updates
  - full `projection:update` remains for connect/resume/recovery
- Added a typed stream bootstrap shape for initial browser state.
- Added Bun host initial rendering support:
  - the host can resolve an HTTP request to a program route/params
  - it connects the runtime, builds bootstrap state, renders HTML, and injects bootstrap JSON into the shell
- Split the approval UI into a reusable `ApprovalApp`, a browser hydration entry, and a server render adapter.
- Wired the browser client to prefer bootstrap resume state over stored resume state.
- Hardened the patch contract after review:
  - region-value patches now require replacement values
  - unpatchable regions fall back to `projection:update`
  - patch-only replay includes a projection baseline
  - projection/resource failures return framework error envelopes
  - affected sessions receive trace envelopes for action-caused patches

## Verification

- `bun test`: 38 tests pass.
- `bun run check`: typecheck, lint, and format check pass.
- Browser smoke on local Bun host port 3100:
  - loaded approval demo
  - selected a deployment
  - approved it through the server program
  - observed pending list/detail update
  - observed action trace with `region patch streamed`
  - reloaded into `refreshed` resume state
- Browser smoke on local Bun host port 3000 after snapshot/bootstrap work:
  - loaded server-rendered approval HTML
  - hydrated into an open stream using bootstrap resume state
  - selected a deployment through a session patch
  - approved it through an action/resource patch
  - observed pending list/detail/trace update without a normal full projection
  - browser warning/error log was empty

## Remaining Stage 5 Follow-Ups

- Decide whether the next patch layer should be a framework-owned UI tree or a Flight-style adapter spike.
- Add a live resource or process-resource demo slice after patch delivery is no longer scaffold.
- Add a route-pattern/API ergonomics pass after patch semantics stay stable.
- Decide store retention/versioning policy for longer-lived replay and schema changes.
