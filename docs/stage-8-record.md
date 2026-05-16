# Stage 8 Record

## Goal

Implement the Review 5 pivot: make the stateless/serverless claim more honest through invocation
results, atomic store commits, scoped observation indexing, client input identity, reconnecting
browser streams, invocation context, projection patch manifests, and a richer demo surface.

## Decisions Implemented

- Added invocation context as an Effect service so actions, resources, projections, and plugins can
  receive request identity, client input IDs, and fanout scope without process-global state.
- Made the stateless runtime trace reader stable by removing the `traces` getter's runtime
  construction side effect.
- Added runtime protocol events and delivery intents beside stream envelopes so the kernel has a
  transport-neutral result surface.
- Added `RuntimeStore.commitInvocation()` with cursor assignment, checkpoint writes, observation
  writes, and client input records in one store operation.
- Added checkpoint revisions and commit-conflict errors for stale checkpoint writes.
- Added scoped observation-index methods and moved stateless invalidation to indexed lookup before
  falling back to development-store view scans.
- Added client-generated input IDs, action lifecycle envelopes for input-ID-correlated pending
  state, and input records in the runtime store.
- Added reconnect/backoff to the browser stream client, with latest-cursor resume on reconnect and
  conservative disconnected-send rejection.
- Added malformed server-envelope handling in the browser stream client.
- Added projection patch manifests so adapters can apply canonical region-value patches without
  app-authored per-region patch handlers.
- Updated the approval demo with manifest-driven patches, pending approval UI, and a live
  deployment-runs panel backed by a resource.
- Added optional Bun dev watch mode that rebuilds the browser bundle and injects a reload client
  during development.

## Verification

- `bun test`: 56 tests pass.
- `bun run check`: typecheck, lint, and format check pass.
- Browser smoke on local Bun host port 3100:
  - loaded the approval demo
  - observed the live deployment runs panel
  - selected a deployment
  - approved it through the server program
  - observed pending list/detail/trace updates
  - confirmed no app-level browser errors blocked the workflow

## Remaining Follow-Ups

- The invocation core still returns stream envelopes directly alongside protocol events. A later
  pass should make protocol events the primary kernel result and move envelope encoding fully to
  transport adapters.
- Memory and JSON stores now expose the right contract shape, but remain single-writer development
  adapters.
- Client input IDs are recorded and lifecycle start is emitted, but full retry/dedupe/unknown
  in-flight recovery remains deferred.
- Observation indexing is implemented for development stores; a production adapter still needs
  real atomic multi-writer behavior.
- The demo now has a live/process resource panel, but a true second route or nested layout
  navigation remains a useful future proof point.
