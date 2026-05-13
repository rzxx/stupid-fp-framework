# Framework State Review

## Purpose

This report audits the current framework against the design docs with ideal-strict alignment. It is not an implementation plan and does not fix code. It records what is solid, what is valid scaffold, what is risky, what deviates from the intended model, and what is still missing.

Sources reviewed:

- `docs/design/model.md`
- `docs/design/runtime.md`
- `docs/design/experiments.md`
- `docs/design/developer-experience.md`
- `docs/kernel-hardening-plan.md`
- `docs/stage-3-plan.md`
- `src/framework/*`
- `src/client/*`
- `src/demo/approvals/*`
- `tests/*`

## Current Verification State

- `bun test` passes: 18 tests.
- `bun run check` currently fails on formatting for stage-3-touched files.
- Worktree was clean before this report was added.

The formatting failure should be treated as repo hygiene debt, not a framework design failure. It still matters because future agents should not assume the project is currently check-clean.

## Grade Legend

- **Done properly**: aligned with design direction and safe to build on.
- **Valid scaffold**: intentionally temporary, documented, and not blocking the intended path.
- **Risky shortcut**: works now but could cause patch-on-patch architecture if not moved soon.
- **Deviation**: conflicts with the design docs or needs to be moved toward the proper shape.
- **Missing**: design-doc concept is not represented yet.

## Executive Summary

The project is moving in the intended direction. The core loop exists:

```txt
browser message -> server program -> action/effect -> resource invalidation
-> projection recompute -> stream envelope -> React render -> trace
```

The strongest pieces are the server-program runtime vocabulary, explicit resources/actions/sessions, contract-style fake-program tests, and the approval demo as an operational workflow proof.

The biggest gaps versus the ideal design are:

- no real patch delivery yet, only whole projections plus region metadata
- no live resource fanout or external invalidation loop
- resume restores snapshots but does not replay missed stream history meaningfully
- program routing is still single-screen
- stream validation is shallow
- action input validation and effect capabilities are mostly userland convention
- trace is useful but not yet a devtools-grade causal model
- React adapter is generic at the stream-client layer, but rendering remains demo-owned

The main architectural risk is that region observation, cursor history, and resume were added as metadata around whole-projection recomputation. That is valid scaffold only if the next kernel work moves those concepts into runtime behavior instead of piling partial patch behavior on top of the current shape.

## Subsystem Review

### Program

Current state:

- `defineProgram` registers one screen, resources, actions, services, and one session definition.
- Runtime dispatch uses `actionByType` and otherwise treats messages as session updates.
- Evidence: `src/framework/program.ts`, `src/framework/runtime.ts`.

Design-doc expectation:

- A `Program` is the fullstack application unit.
- It should declare screens/routes, provide services/effect capabilities, route messages, connect sessions to resource subscriptions, produce projections, and record traces.

Alignment grade: **Valid scaffold**.

Done properly:

- The program is more than a route handler.
- Actions, resources, session state, projection, and services are grouped under one unit.
- The approval app does not expose app-defined REST/RPC endpoints for workflow operations.

Shortcut/deviation notes:

- Only one screen is supported. There is no screen registry or route resolution.
- Message routing is action-type lookup plus fallback to session update. That is simple, but it hides invalid message handling and makes every unknown message look like a session message.
- Services are plain object dependencies, not an effect capability graph.

Recommended next move:

- Add a multi-screen program registry before adding a second demo.
- Make message routing explicit: action messages, session messages, system messages, and invalid messages should not collapse into the same fallback path.

### Screen And Projection

Current state:

- Screens project route params, services, resources, session state, traces, and regions into a serializable projection.
- Named regions exist through `context.region(id, read)`.
- Projection envelopes include full projection plus region/resource metadata.
- Evidence: `src/framework/projection.ts`, `src/framework/resource.ts`, `src/demo/approvals/screen.tsx`, `src/framework/stream.ts`.

Design-doc expectation:

- A screen declares observed resources and turns route params plus session state plus resources into a projection.
- Projections can later be React trees, framework UI trees, serialized patches, or other renderable models.
- The runtime should recompute affected projection regions and stream patches eventually.

Alignment grade: **Valid scaffold**, with **risky shortcut** around projection shape.

Done properly:

- Whole-projection updates are explicitly documented as temporary in `docs/stage-3-plan.md`.
- Region metadata is now present, so future patch work has a clear bridge.
- React does not own durable workflow state.

Shortcut/deviation notes:

- Region observation is runtime metadata only. It does not drive partial recomputation or stream behavior.
- The projection is still application data for a React UI, not a renderer-agnostic projection model.
- `context.region` is imperative and nested inside projection code. The developer-experience docs sketch a more declarative `Screen.define(...).observe(...).view(...)` style.

Recommended next move:

- Decide the first patch representation before adding more UI complexity.
- Keep full projections as fallback, but add one real behavior that uses region metadata, such as invalidation-targeted recomputation or named-region patch envelopes.

### Message And Stream

Current state:

- JSON envelopes define connect, message, connected, projection update, action result, trace update, and error.
- Connect includes route, params, and optional resume `{ sessionId, cursor }`.
- Server envelopes carry cursors where meaningful.
- Evidence: `src/framework/stream.ts`, `src/client/program-stream.ts`, `src/server.ts`.

Design-doc expectation:

- The stream is a primitive.
- It should carry messages, projections, UI patches, action lifecycle events, resource update notifications, trace events, and reconnect/resume cursors.
- It should avoid traditional endpoint/RPC gravity.

Alignment grade: **Valid scaffold**.

Done properly:

- The browser sends framework messages, not app API calls.
- Cursors and resume shape exist.
- Client stream handling was extracted into a generic adapter.

Shortcut/deviation notes:

- Runtime does not use `readEnvelopesAfter` during resume, so cursor history is stored but not operational.
- Parser validation checks only envelope shell shape. It does not validate message payloads, action input, route params beyond string records, or unknown message type.
- Invalid resume falls back to fresh session behavior without a strong semantic signal.
- Route mismatch on resume is not guarded. A stored session can be restored regardless of the incoming route/params.

Recommended next move:

- Define resume semantics precisely: restored, replayed, refreshed, rejected, or fresh fallback.
- Add a stream contract test suite that treats the protocol as a black-box transport, not just parser functions.

### Action And Effect

Current state:

- Actions return `Effect.Effect<void, ActionFailure, never>`.
- `framework/effect.ts` exports Effect through a framework boundary.
- Approval action performs validation, auth, permission, writes, audit, invalidation, and trace events.
- Evidence: `src/framework/action.ts`, `src/framework/effect.ts`, `src/demo/approvals/actions.ts`.

Design-doc expectation:

- Actions should be named server transactions.
- Effects should make capabilities visible and testable.
- Actions should describe input, services/capabilities, durable mutations, invalidations, trace events, and UI outcomes.

Alignment grade: **Valid scaffold**.

Done properly:

- The action reads as a workflow transaction, not an endpoint handler.
- Effect is intentionally exposed as a power tool while browser contracts stay Effect-free.
- Failure uses typed `ActionFailure` instead of thrown application errors.

Shortcut/deviation notes:

- There is no action input schema or runtime payload validation.
- Services are directly available as a plain object. Effect Context/Layer is exported but not used as a capability boundary.
- `ActionEffect` cannot return useful action data. The only action result payload is success/error, not typed domain output.
- Trace event discipline is manual; the framework does not distinguish validation/auth/write phases structurally.

Recommended next move:

- Add action input validation and typed action result payloads before adding more actions.
- Decide whether Effect services become real capabilities or remain an implementation detail.

### Resource Graph

Current state:

- Resources use typed keys with type/id/label.
- Resource graph caches reads, tracks observations, supports named regions, and invalidates explicit keys.
- Runtime can report affected regions for invalidated keys.
- Evidence: `src/framework/resource.ts`, `src/framework/runtime.ts`, `tests/framework-contract.test.ts`.

Design-doc expectation:

- Resources replace fetch/cache soup.
- Screens observe resources. Actions invalidate resources. Runtime owns refresh, recomputation, subscriptions, and patch delivery.
- Resources may represent entities, queries, live feeds, and long-running process state.

Alignment grade: **Valid scaffold**, with **risky shortcut** around concurrency and live behavior.

Done properly:

- Resource keys and observation are real.
- Invalidation is explicit and test-covered.
- Affected-region lookup is an important step toward avoiding manual cache updates.

Shortcut/deviation notes:

- Observation stack is stored on `ResourceGraph`. Concurrent projections could interfere because the active observer is global to the graph.
- Invalidation only clears cache. It does not notify sessions, trigger recomputation, or fan out updates.
- Resources are still simple loaders. There is no entity/query/feed/process distinction.
- No stale state, subscriptions, background invalidations, or external resource updates.

Recommended next move:

- Move observation tracking into an isolated projection execution context so concurrent projections are safe.
- Add an explicit external invalidation path that can recompute/fan out to affected sessions.

### Session

Current state:

- Sessions hold route, params, state, projection version, cursor, and observed regions.
- Session snapshots can be persisted and restored.
- Approval session stores selected deployment and trace panel open state.
- Evidence: `src/framework/session.ts`, `src/framework/runtime.ts`, `src/demo/approvals/session.ts`.

Design-doc expectation:

- Session is per-tab conversational state.
- It should be live and useful, but not trusted as durable truth.
- It should support reconnect cursors, snapshots, restoration, and resource re-observation.

Alignment grade: **Valid scaffold**.

Done properly:

- Session state is separate from durable deployment data.
- Resume can restore session-only state and recompute a fresh projection.
- Session state in the approval demo is correctly conversational.

Shortcut/deviation notes:

- Snapshot schema is framework-private but not versioned.
- There is no restore failure model beyond silent fresh-session fallback.
- Session snapshot stores observed regions, but runtime re-observation after resume is the real source of current resource truth.
- Client local filter is intentionally not session state, which is fine, but it does not prove richer client island/session interactions.

Recommended next move:

- Define restore modes and failure behavior.
- Add tests for route mismatch, stale cursor, missing snapshot, and corrupted store data.

### Trace

Current state:

- Traces are session-scoped.
- Trace events include phase, label, timestamp, and optional detail.
- Action, resource, projection, stream, and error events are visible in the demo.
- Evidence: `src/framework/trace.ts`, `src/framework/runtime.ts`, `src/demo/approvals/actions.ts`.

Design-doc expectation:

- Trace should explain why UI changed from click to patch.
- It should include validation, auth, effects, writes, invalidations, recomputation, and streamed patch.
- Traceability is core value, not polish.

Alignment grade: **Done properly** for current prototype, **valid scaffold** for ideal devtools.

Done properly:

- Successful approval traces tell a useful story.
- Failed actions produce error status and preserve causality.
- Browser trace panel demonstrates the value clearly.

Shortcut/deviation notes:

- TraceStore is in-memory and not part of runtime persistence.
- Trace events are manually emitted and not tied to a structured action/effect lifecycle.
- Trace safety is not addressed. Browser receives all trace detail currently placed in the trace.
- Because there are no patches yet, trace cannot identify patch/region payloads beyond projection metadata.

Recommended next move:

- Add a trace policy layer for browser-safe vs dev-only details.
- Connect trace events to regions/patches when patch delivery begins.

### React Adapter

Current state:

- `connectProgramStream` is generic over message/projection/trace types.
- Approval-specific wrapper uses route/params/storage key.
- Client stores session/cursor in `sessionStorage`.
- Demo includes a local React filter that does not mutate server state.
- Evidence: `src/client/program-stream.ts`, `src/client/stream-client.ts`, `src/client/app.tsx`.

Design-doc expectation:

- React renders projections and hosts client islands.
- React should not own data fetching, mutation, cache invalidation, or workflow state.
- Normal React components should remain usable.

Alignment grade: **Valid scaffold**.

Done properly:

- The stream adapter is no longer approval-only.
- Local island demonstrates React state without durable ownership.
- Workflow actions still go through server messages.

Shortcut/deviation notes:

- The adapter is a browser utility, not a coherent React adapter API.
- No hook/component abstraction exists for framework streams.
- Client-side resume storage is hardcoded to `sessionStorage` behavior per stream options.
- The app renders projection data manually; no renderer abstraction or client island protocol exists.

Recommended next move:

- Add a small React adapter API, likely a hook, that wraps connection state, projection, traces, action result, errors, and send.
- Keep it projection-driven and avoid introducing query/cache patterns.

### Bun Host

Current state:

- `src/server.ts` builds the client bundle on startup, serves shell/assets, upgrades `/stream`, and wires WebSocket messages into runtime.
- Optional `RUNTIME_STORE_PATH` enables `JsonFileRuntimeStore`.

Design-doc expectation:

- Bun host should be the practical first runtime target.
- It should provide request/socket entrypoints, bundling/dev server integration, and local development story.
- Bun should not become the whole architecture.

Alignment grade: **Valid scaffold**.

Done properly:

- Bun host is thin enough that kernel concepts still live under `src/framework`.
- The app does not need app-defined HTTP endpoints for workflow.

Shortcut/deviation notes:

- Bun host is hand-written, not an adapter module.
- Build/dev behavior is minimal and not framework-shaped.
- Runtime instance is global singleton in server process.
- There is no host abstraction for alternative runtimes or serverless constraints.

Recommended next move:

- Extract a Bun host adapter that accepts a program/runtime and stream options.
- Keep app server code small enough that demos do not define framework plumbing manually.

### Demo

Current state:

- Approval workflow has fake auth, permission, writes, audit, invalidation, session selection, traces, resume, and local React filter.
- Evidence: `src/demo/approvals/*`, `src/client/app.tsx`.

Design-doc expectation:

- Early demo should be a compact operational workflow proving server-owned state, permissions, audit, traces, resources, and React compatibility.

Alignment grade: **Done properly** for current demo scope.

Done properly:

- The approval workflow is the right kind of domain.
- Durable deployment state does not live in React.
- Permission failure and duplicate approval failure are tested.
- Trace panel communicates the architecture.

Shortcut/deviation notes:

- Demo uses in-memory services as durable truth.
- Current UI is still a custom app, not a showcase of framework-level developer experience.
- No incident/AI live scenarios yet, so live feeds and long-running process resources remain unproven.

Recommended next move:

- Do not add a second demo until resource fanout or patch semantics are clearer.
- Use approvals to harden framework APIs first.

### Tests

Current state:

- 18 tests pass.
- Tests are split into framework contract tests, runtime/protocol tests, and approval workflow acceptance tests.
- Browser verification has been manual, not automated.
- Evidence: `tests/framework-contract.test.ts`, `tests/runtime.test.ts`, `tests/approvals.test.ts`.

Design-doc expectation:

- Tests should verify framework promises, not just implementation functions.
- The project should support test-driven framework evolution with black-box contracts.

Alignment grade: **Valid scaffold**.

Done properly:

- Fake-program contract tests are the right direction.
- Approval tests cover domain behavior rather than private helper functions.
- Runtime tests cover stream envelope ordering and malformed envelope shell.

Shortcut/deviation notes:

- Some tests assert exact envelope order and exact region arrays. That can become implementation-coupled if stream semantics evolve.
- Store tests are direct unit tests more than black-box runtime behavior.
- No automated browser/integration test exists for the generic client adapter.
- No tests for invalid resume, route mismatch, stale cursor, replay/fallback, concurrent projections, or malformed message payloads.

Recommended next move:

- Build a reusable black-box runtime fixture that can test any implementation exposing connect/receive/stream behavior.
- Keep approval tests as demo acceptance.
- Add limited browser smoke tests for integration confidence only.

### Docs

Current state:

- Design docs are split and useful.
- Stage plans document intentional shortcuts.
- This review now records alignment and gaps.

Design-doc expectation:

- Future agents should be able to understand what is intentional, what is open, and what should not be built yet.

Alignment grade: **Done properly**, with a hygiene issue.

Done properly:

- `docs/stage-3-plan.md` clearly says whole projections and file store are intentional scaffolds.
- Design docs explain the project identity and non-goals.

Shortcut/deviation notes:

- Some docs are now ahead of implementation, especially patch delivery, subscriptions, multi-screen routing, and devtools.
- `bun run check` formatting failure means docs/code committed state needs cleanup before the next implementation stage.

Recommended next move:

- Keep adding decision records before major implementation stages.
- Add a short "current implementation status" index or link this review from `docs/design/README.md` after formatting is restored.

## Contract Map

| Framework promise | Current evidence | Coverage status | Gap |
| --- | --- | --- | --- |
| Browser sends framework messages, not app APIs | `src/client/program-stream.ts`, `src/server.ts` | Runtime/protocol tests and browser manual verification | No automated browser smoke test |
| Program groups resources/actions/session/projection | `src/framework/program.ts` | Framework contract tests | Only one screen |
| Session state is separate from durable resources | `tests/framework-contract.test.ts`, `tests/approvals.test.ts` | Covered | Need richer session restore failure tests |
| Actions mutate durable state and invalidate resources | `tests/framework-contract.test.ts`, `tests/approvals.test.ts` | Covered | No typed result payloads or input validation |
| Failed actions do not mutate durable state | `tests/framework-contract.test.ts`, `tests/approvals.test.ts` | Covered | Failure taxonomy is shallow |
| Resources are observed during projection | `tests/framework-contract.test.ts` | Covered | Single-resource/simple-region coverage only |
| Invalidated resources map to affected regions | `tests/framework-contract.test.ts` | Covered | Not used for fanout or patches |
| Whole projection updates stream to browser | `tests/runtime.test.ts`, browser manual verification | Covered | No patch/region update protocol |
| Resume restores session state | `tests/framework-contract.test.ts`, browser manual verification | Covered | No replay/fallback/invalid resume semantics |
| Store envelope history exists | `tests/framework-contract.test.ts` | Unit-level covered | Runtime does not use it on resume |
| Traces explain actions | `tests/runtime.test.ts`, browser manual verification | Covered | Trace safety/devtools model missing |
| React can host local-only state | Browser manual verification | Manual only | No adapter/client tests |
| Renderer-agnostic kernel pressure | `src/framework` avoids React imports | Partially covered by architecture | Projection shape is still demo data |
| Live resource updates | None | Not covered | Missing |
| Multi-screen routing | None | Not covered | Missing |
| RSC/Flight adapter optionality | Docs only | Not covered | Intentionally missing |

## Tests That Are Too Implementation-Coupled

- Exact envelope order in `tests/runtime.test.ts` may become brittle when replay, pending states, or patch envelopes land.
- Exact region array equality in `tests/framework-contract.test.ts` is useful now, but should evolve into semantic assertions once multiple regions/resources exist.
- Store history tests call `nextCursor` and `appendEnvelope` directly. That verifies the adapter, not full runtime resume behavior.

## Missing Black-Box Scenarios

Highest priority:

- invalid resume object and invalid resume target
- route/params mismatch on resume
- stale cursor behavior
- replay vs fresh projection fallback
- corrupted JSON file store behavior
- multiple resources read in one region
- same resource read in multiple regions
- external resource invalidation affecting one of two sessions
- concurrent projection observation safety
- trace status/order after success and failure
- malformed message payload beyond envelope shell

Medium priority:

- generic client adapter stores and reuses cursor
- browser reload resumes session without preserving local-only island state
- action result payload shape once actions can return data
- framework behavior when projection throws
- resource loader failure behavior and trace output

## Recommended Test Architecture

Keep:

- fake-program contract tests as the main framework guardrail
- approval workflow tests as demo acceptance
- runtime/protocol tests for envelope shape and ordering where necessary

Add:

- a reusable black-box runtime fixture that builds small programs with resources, sessions, actions, and traces
- shared store contract tests that can run against memory, file, and future adapters
- a small stream/client adapter test with mocked WebSocket and session storage
- a limited browser smoke test for the approval demo after major UI/runtime changes

Avoid:

- tests that assert private method behavior
- tests that overfit the approval demo as the only framework proof
- broad browser E2E as the main correctness layer

## Priority Follow-Up Queue

1. Restore repo hygiene: run formatter and make `bun run check` pass.
2. Define resume semantics: restored, replayed, refreshed, rejected, or fresh fallback.
3. Move resource observation tracking out of shared global stack state.
4. Add explicit invalid-message handling instead of treating unknown messages as session updates.
5. Add action input validation and typed action result payloads.
6. Use affected regions for one real runtime behavior: targeted recompute, fanout, or named-region patch envelope.
7. Extract Bun host adapter from demo server plumbing.
8. Add React adapter hook around the generic stream client.
9. Add trace safety policy and patch/region trace linkage.
10. Add multi-screen routing only after the single-screen runtime semantics are cleaner.

## Bottom Line

The framework is coherent and still aligned with the design direction. It is not just becoming a worse Next/Remix clone, and it is not merely RPC with nicer syntax. The server-program shape is visible in code and tests.

The main danger now is leaving the stage-3 scaffolds as permanent architecture. Region metadata, cursors, stores, and traces need to start driving runtime behavior soon. Otherwise future work will pile patch delivery, replay, and live updates on top of metadata that was never designed to own those responsibilities.
