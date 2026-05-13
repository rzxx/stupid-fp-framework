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

## Progress

- Stage 1 done: restored formatting hygiene, confirmed `bun test` and `bun run check` pass.
