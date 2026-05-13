# Stage 6 Record

## Goal

Turn the Stage 5 runtime into a cleaner framework kernel by removing the main review-3 deviations:
decorative Effect usage, plain service plumbing, handwritten message validators, exact-string
route confusion, missing plugin hooks, weak store contracts, global demo CSS ownership, and a wide
React adapter state surface.

## Decisions Implemented

- Effect is now the native server capability model for actions, resources, and projections.
- Programs provide services through Effect `Layer`s and run work through `ManagedRuntime`.
- Actions and sessions now have schema-backed builder APIs while lower-level object manifests remain available.
- Screens can use first-class route definitions with decoded params.
- Plugins are ordinary TypeScript values with Effectful hooks for actions, resources, routes, sessions, traces, hosts, and renderers.
- Runtime stores now expose capability metadata and typed store failures; JSON corruption is reported as `RuntimeStoreError`.
- Session snapshots now carry snapshot version metadata.
- React adapter code lives under `src/adapters/react`; approval UI and CSS live under `src/demo/approvals/client`.
- `useProgramStream` now returns grouped connection/session/projection/action/error/diagnostic state instead of a flat bag.

## Verification

- `bun test`: 42 tests pass.
- `bun run check`: typecheck, lint, and format check pass.

## Remaining Follow-Ups

- Production persistence adapters are still intentionally unchosen; Memory and JSON remain development adapters.
- Plugin layers are represented in the plugin shape, but no production integration package model exists yet.
- Renderer/UI-tree and Flight-style adapters remain deferred; Stage 6 only preserved adapter boundaries.
