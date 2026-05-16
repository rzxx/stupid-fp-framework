# Stage 9 Record

## Goal

Implement the Review 6 direction: make projection patches screen-owned, add real route transition
support, keep Bun-native development canonical with asset hooks, converge the public API on named
builders, and document state placement rules.

## Decisions Implemented

- Moved projection patch manifest types into the framework projection protocol.
- Added screen-owned `patchManifest` support and included manifest versions on projection update
  and patch envelopes.
- Moved the approval patch manifest out of the React component and into a shared screen/program
  boundary module.
- Added `system.navigate` as a runtime input that resolves routes, updates the view checkpoint, and
  emits navigation traces.
- Added React adapter navigation helpers with history-mode popstate handling.
- Expanded the approval demo to two screens: deployments and deployment runs.
- Added a lightweight layout declaration and shared layout projection region for team, current
  user, navigation, and trace panel state.
- Added Bun-native style asset hooks with output routes, watch roots, custom build functions, and a
  dev status endpoint.
- Migrated the demo server from legacy `stylesPath` to the asset hook path.
- Added named builder APIs for `Resource`, `UIState`, `Screen`, and `Program`.
- Migrated the approval demo to the named builder APIs.
- Kept in-flight action recovery explicitly unsupported: the React adapter clears pending action
  inputs and reports an error if the stream closes before an action result arrives, while navigation
  inputs are not tracked as pending actions.
- Updated public docs and README examples to teach the builder syntax and state placement rule.
- Superseded the broad "local React state is valid local UI state" wording. Current docs treat
  `UIState` as the framework's app-level view/editing state and React state as adapter/render
  mechanics only.
- Added React adapter optimistic projection overlays and split canonical app input calls into
  `stream.ui.send` and `stream.actions.run`.

## Verification

- `bun run format`
- `bun run check`
- `bun test`

## Remaining Follow-Ups

- `Action.define(...).input(...).run(...)` already matches the builder style, but actions could
  still gain named result/error metadata later.
- Layout declarations are intentionally lightweight. A future pass can add layout-specific UI
  policy if the two-screen demo exposes enough pressure.
- Rich in-flight action recovery after disconnect is still conservative. Client input IDs and input
  records exist, but automatic recover/dedupe/unknown-commit semantics need a focused protocol pass.
