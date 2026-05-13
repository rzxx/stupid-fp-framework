# Stage 4 Record

## Goal

Close the alignment gaps from `docs/framework-state-review.md` by moving Stage 3 scaffold toward the durable server-program design. This is an implementation record, not a new design spec.

## Working Rules

- Treat each review priority as a separate commit-sized stage.
- Keep tests contract-first and demo tests as acceptance coverage.
- Run `bun run format`, `bun test`, and `bun run check` before implementation commits.
- Prefer moving scaffold into runtime behavior over piling new behavior around it.

## Stage Queue

1. Repo hygiene and record setup.
2. Resume semantics and black-box protocol coverage.
3. Isolated resource observation and explicit invalid-message handling.
4. Action input validation and typed action results.
5. Region-aware runtime behavior and trace linkage.
6. Bun host adapter extraction.
7. React adapter hook.
8. Trace safety policy.
9. Multi-screen routing after single-screen semantics are cleaner.

## Decisions

- Resume should be explicit in the stream protocol: restored, replayed, refreshed, rejected, or fresh fallback.
- Whole projections remain the fallback, but region metadata must start affecting runtime output.
- `JsonFileRuntimeStore` remains a dev/test adapter, not the app persistence model.
- React integration should become an adapter surface without introducing client cache ownership.
- Resume now keeps the old `resumed` boolean for client compatibility, but the durable semantic field is `connected.resume`.
- Session message handling is now explicit through `SessionDefinition.accepts`; unknown messages fail at the kernel boundary.
- Action payload validation belongs on each action definition before effects run; successful actions may return JSON result data through `action:result`.
- Region metadata now drives `projection:patch` envelopes and `runtime.invalidate()` fanout; full projections remain the fallback payload.

## Progress

- Stage 1 done: restored formatting hygiene, confirmed `bun test` and `bun run check` pass.
- Stage 2 done: added explicit resume statuses, cursor-history replay, stale-cursor refresh, route-mismatch rejection, and contract tests.
- Stage 3 done: moved resource observation to async-local scopes, added explicit invalid-message rejection, and covered parser payload validation.
- Stage 4 done: added action validators, typed JSON result payloads, and invalid-action contract coverage.
- Stage 5 done: added region patch envelopes, external invalidation fanout, and trace linkage for invalidated regions.

## Skips

- Action-triggered cross-socket delivery is not complete because the Bun host does not yet keep a session-to-socket registry. The kernel computes/fanouts through `runtime.invalidate()`, while `receive()` only returns envelopes for the initiating session.
