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

## Verification

- `bun test`: 31 tests pass.
- `bun run check`: typecheck, lint, and format check pass.
- Browser smoke on local Bun host port 3100:
  - loaded approval demo
  - selected a deployment
  - approved it through the server program
  - observed pending list/detail update
  - observed action trace with `region patch streamed`
  - reloaded into `refreshed` resume state

## Remaining Stage 5 Follow-Ups

- Decide whether the next patch layer should be a framework-owned UI tree or a Flight-style adapter spike.
- Reduce reliance on full `projection:update` as normal post-patch output once recovery semantics are clearer.
- Add projection/resource failure behavior.
- Add a live resource or process-resource demo slice after patch delivery is no longer scaffold.
