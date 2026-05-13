# Framework State Review 2

## Purpose

This report audits the current framework after Stage 4 against the full design-doc project image. It is intentionally strict. The goal is not to preserve the current shape, but to identify what is now solid, what is useful scaffold, what risks becoming permanent accident, and what Stage 5 should improve.

This is not an implementation patch. It is a Stage 5 planning review.

Sources reviewed:

- `docs/design/model.md`
- `docs/design/runtime.md`
- `docs/design/developer-experience.md`
- `docs/design/experiments.md`
- `docs/proposal.md`
- `docs/prototype-plan.md`
- `docs/kernel-hardening-plan.md`
- `docs/framework-state-review.md`
- `docs/stage-4-record.md`
- `src/framework/*`
- `src/client/*`
- `src/demo/approvals/*`
- `tests/*`
- `README.md`

## Current Verification State

- Worktree is clean.
- `bun test` passes: 28 tests.
- `bun run check` passes: typecheck, lint, and format check.

This is a meaningful improvement over the first review. The project is now check-clean, and the old "framework metadata exists but does not drive behavior" problem has been reduced. It is not gone.

## Grade Legend

- **Done properly**: aligned with the design direction and safe to build on.
- **Valid scaffold**: intentionally temporary or incomplete, but shaped so the intended design can still grow from it.
- **Risky shortcut**: works now, but likely to create patch-on-patch architecture if Stage 5 builds around it.
- **Deviation**: conflicts with the design direction or gives developers the wrong mental model.
- **Missing**: design-doc concept is not represented yet.

## Executive Summary

Stage 4 materially improved the framework. The runtime now has explicit resume statuses, cursor replay, async-local resource observation, explicit invalid-message rejection, action payload validators, typed action result payloads, region invalidation patch envelopes, external invalidation fanout at the kernel boundary, a Bun host adapter, a React hook, browser/dev trace visibility, and multi-screen registration.

The strongest current loop is:

```txt
browser message
-> runtime receive
-> action/session dispatch
-> Effect action or session update
-> resource invalidation
-> affected region lookup
-> projection:patch invalidation notice
-> whole projection recompute
-> React render
-> trace update
```

That is coherent, but it is not yet the design-doc ideal:

```txt
browser event
-> typed message
-> server program
-> effect transaction
-> resource changes
-> recomputed projection region or UI tree
-> streamed UI patch
```

The main Stage 5 pressure is the UI update mechanism. Current `projection:patch` envelopes say which regions were invalidated, but they do not carry replacement region values, structural diffs, UI-tree patches, or renderer payloads. The client stores the last patch, but still updates visible UI from `projection:update`. Full projection replacement is still the effective UI update mechanism.

Stage 5 should therefore treat UI updates as a design-center problem. That does not mean only doing patches. It means making the patch choice clarify the rest of the framework: projection shape, region API, React adapter responsibility, trace causality, socket delivery, test contracts, and future demo scenarios.

## Stage 4 Delta From The First Review

| First-review gap                                | Current state                                                                        | New grade                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| Repo hygiene failed formatting                  | Clean `bun run check`                                                                | **Done properly**                   |
| Resume had shallow semantics                    | Explicit `fresh`, `rejected`, `refreshed`, and `replayed` statuses with store replay | **Valid scaffold**                  |
| Cursor history existed but was not operational  | Runtime uses `readEnvelopesAfter` on resume                                          | **Done properly** for prototype     |
| Route mismatch on resume was unguarded          | Route and params are checked before restore                                          | **Done properly**                   |
| Resource observation used shared stack state    | `ResourceGraph` uses `AsyncLocalStorage`                                             | **Done properly**                   |
| Unknown messages fell through to session update | `SessionDefinition.accepts` rejects unknown messages                                 | **Done properly**                   |
| Action input validation was userland convention | `defineAction` requires an `accepts` validator                                       | **Valid scaffold**                  |
| Action results could not return data            | `action:result.result` carries JSON values                                           | **Done properly**                   |
| Affected regions did not drive runtime output   | Runtime emits `projection:patch` and supports `runtime.invalidate()` fanout          | **Valid scaffold**                  |
| Bun host was demo plumbing                      | `serveBunProgram` is a framework adapter                                             | **Done properly** for current scope |
| React adapter was stream utility only           | `useProgramStream` exists                                                            | **Valid scaffold**                  |
| Trace safety not addressed                      | Browser/dev visibility exists                                                        | **Valid scaffold**                  |
| Multi-screen routing missing                    | Program normalizes a screen registry and exact route lookup                          | **Valid scaffold**                  |

The old priority queue has mostly been executed. Stage 5 should not repeat Stage 4 under new names. It should confront the deeper decisions that Stage 4 exposed.

## Subsystem Review

### Program

Current state:

- `defineProgram` groups services, resources, session definition, screens, and actions.
- Programs can now register multiple screens through `screens`.
- Runtime resolves exact route strings through `screenByRoute`, with single-screen fallback.
- Message dispatch is explicit enough to distinguish actions, accepted session messages, and invalid messages.

Design-doc expectation:

- A `Program` is the fullstack application unit.
- It declares screens/routes, services/effect capabilities, sessions, resources, actions, projections, traces, and message routing.

Alignment grade: **Valid scaffold**.

Done properly:

- The program shape is not endpoint-first.
- Multiple screens exist without introducing file-router gravity.
- Unknown messages now fail at the kernel boundary.

Remaining gaps:

- Route matching is exact string matching, not route-pattern resolution.
- A single session definition applies to the whole program. That is fine for the demo, but multi-screen apps may need screen-specific session shape or a discriminated session model.
- Services are still plain objects. The framework exports Effect `Context` and `Layer`, but the program does not model capabilities as an effect graph.
- There is no manifest-like description of messages, resources, actions, routes, or client/server boundaries.

Recommended next move:

- Keep exact routes until patch semantics are clearer.
- When API ergonomics work begins, design program manifests around the runtime concepts already proven by tests: screens, resources, actions, messages, sessions, and traces.

### Screen And Projection

Current state:

- Screens project route params, services, resources, session state, traces, and named regions into serializable app data.
- `context.region(id, read)` records which resources were read inside each region.
- Projection envelopes include region metadata.
- Patch envelopes currently carry invalidated region metadata, not replacement output.

Design-doc expectation:

- A screen declares observed resources and turns route params plus session state plus resources into a projection.
- A projection may be a React tree, framework UI tree, serialized patch, or other renderer payload.
- Runtime should recompute affected projection regions and stream patches.

Alignment grade: **Valid scaffold**, with a **risky shortcut** around projection payloads.

Done properly:

- Region observation is real and isolated across concurrent projections.
- Full projection replacement is no longer undocumented accident. It is a fallback.
- Projection code stays server-side and React does not own workflow data.

Shortcut/deviation notes:

- Regions are observation scopes, not projection output units. A region records reads, but the runtime cannot ask "what is the rendered value of this region?"
- Projection output is still one app-specific JSON object. It is useful for React rendering, but not yet a renderer-agnostic or patchable model.
- The runtime recomputes the entire screen after invalidation. No region-only recompute exists.
- The `projection:patch` name overstates behavior: current patches are invalidation notices, not UI patches.

Recommended next move:

- Stage 5 should decide whether regions are data-value regions, structural diff anchors, or UI/render tree nodes.
- Do not add a second complex demo before this decision, because more UI shape will make the wrong patch model harder to replace.

### Message And Stream

Current state:

- Stream envelopes define connect, message, connected, projection update, projection patch, action result, trace update, and error.
- Resume is explicit through `connected.resume`.
- Parser validation rejects malformed JSON, invalid connect params, invalid resume shape, and message envelopes without a typed message object.
- Stored envelope history is used for replay.

Design-doc expectation:

- The stream carries messages, projections, patches, action lifecycle events, resource update notifications, trace events, and reconnect cursors.
- It should avoid endpoint/RPC gravity.

Alignment grade: **Valid scaffold**.

Done properly:

- The stream protocol is framework-owned and app routes are generic.
- Resume status is understandable at the protocol boundary.
- Cursors now have operational meaning.

Shortcut/deviation notes:

- `projection:patch` does not yet update UI by itself.
- `action:result` is a single success/error event, not an action lifecycle model with pending, validation, authorization, write, retry, or cancellation states.
- Error envelopes are simple strings. There is no stable error taxonomy for validation, auth, projection failure, store failure, or protocol failure.
- Replay sends stored envelopes, but there is no replay compaction, cursor retention policy, snapshot versioning, or conflict model.

Recommended next move:

- Keep the stream custom.
- Add semantic patch contracts before adding more envelope types.
- Treat full `projection:update` as recovery/fallback, not the normal update path once Stage 5 patches land.

### Runtime And Delivery

Current state:

- Runtime can connect, receive messages, compute projections, persist stream envelopes, resolve resume, invalidate resources, and compute affected sessions.
- `runtime.invalidate(keys)` returns patch and projection envelopes for all affected sessions.
- `receive()` filters action-triggered invalidation output to the initiating session through `ownSessionResult`.
- Stage 4 explicitly skipped action-triggered cross-socket delivery because the Bun host does not keep a session-to-socket registry.

Design-doc expectation:

- Runtime should associate browser streams with sessions, refresh affected projections, and stream patches to each relevant browser.
- Live resource updates should find connected sessions observing a changed resource.

Alignment grade: **Valid scaffold**, with a **risky shortcut** around host delivery.

Done properly:

- The kernel knows affected sessions and can compute fanout envelopes.
- External invalidation is a real runtime API.

Shortcut/deviation notes:

- Kernel fanout is not host fanout. The result exists as returned envelopes, but the Bun host only sends envelopes back to the socket that produced the current message.
- Cross-session action effects are conceptually present but not browser-visible through the host.
- There is no lifecycle for connected sockets, disconnected sessions, backpressure, or failed sends.
- The runtime owns much of the behavior, but the host must become a delivery participant for live update claims to be true.

Recommended next move:

- Stage 5 should add a host delivery registry or runtime delivery adapter before claiming real live multi-client behavior.
- Tests should prove that one session action can update another browser when both observe the same resource.

### Resource Graph

Current state:

- Resources have typed-ish keys with type, id, and label.
- Resource loaders are registered by type.
- Reads are cached until invalidated.
- Observation uses async-local scopes and region IDs.
- Invalidated keys map back to observed regions.

Design-doc expectation:

- Resources replace fetch/cache soup.
- Screens observe resources, actions invalidate resources, and runtime owns refresh, recomputation, subscriptions, patch delivery, and live updates.
- Resources may model entities, queries, feeds, and process state.

Alignment grade: **Valid scaffold**.

Done properly:

- Resource keys and observation are clear.
- Concurrency safety is covered by contract tests.
- Resource invalidation feeds runtime behavior.

Remaining gaps:

- Resources are still loader-plus-cache only.
- No entity/query/feed/process distinction exists.
- There is no stale state, loading state, failure state, subscription, or external resource event source model.
- Cache invalidation is all-or-nothing per key.
- Resource reads do not run through Effect capabilities.

Recommended next move:

- Do not overbuild resource kinds before patch semantics.
- After patch semantics are chosen, add one live resource or external event scenario to prove that resource changes can update existing sessions without user action.

### Action And Effect

Current state:

- `defineAction` names an action, validates its message, and runs an Effect.
- Action failures are typed as `ActionFailure`.
- Actions can invalidate resources and return JSON action result data.
- Approval action traces validation, auth, permission, writes, and invalidations.

Design-doc expectation:

- Actions are named server transactions.
- Effects make capabilities visible and testable.
- Actions describe input, services/capabilities, durable mutations, invalidations, trace events, and UI outcomes.

Alignment grade: **Valid scaffold**.

Done properly:

- Actions are workflow transactions, not REST handlers.
- Invalid payloads fail before durable mutation.
- Typed JSON result payloads make the action channel more useful.

Shortcut/deviation notes:

- Validators are hand-written type guards, not schemas or reusable message builders.
- Services are plain object dependencies, not effect capabilities.
- Trace lifecycle remains manual; the framework does not structurally know validation/auth/write phases.
- No pending or optimistic model exists.
- Action result error shape is a string, while `ActionFailure.detail` is not streamed in a structured way.

Recommended next move:

- In Stage 5, avoid making Effect capability design the main work unless patch semantics are blocked by it.
- Add stronger action error/result contracts only where UI patch and trace work needs them.

### Session And Resume

Current state:

- Sessions store route, params, state, projection version, cursor, and observed regions.
- Session snapshots can be persisted and restored.
- Resume supports missing session rejection, route mismatch rejection, stale cursor refresh, current cursor refresh, and replay.
- Client persists session/cursor in `sessionStorage`.

Design-doc expectation:

- Session is per-tab conversational state.
- Losing it must not corrupt product truth.
- Reconnect should restore or rebuild state through snapshots, history, durable resources, and cursors.

Alignment grade: **Done properly** for current prototype, **valid scaffold** for serverless durability.

Done properly:

- Resume semantics are now explicit.
- Store replay is real.
- Session state remains separate from durable approval data.

Remaining gaps:

- Session snapshots are not versioned.
- Corrupted JSON store behavior is not handled or tested.
- Replay history has no retention or compaction model.
- Resume does not account for changed program definitions or projection schema changes.
- Client resume storage is fixed to browser `sessionStorage`.

Recommended next move:

- Keep current resume model as the recovery baseline while patches evolve.
- Add tests for corrupted stores and projection/schema version mismatches only when a versioning policy is chosen.

### Trace

Current state:

- Traces are session-scoped.
- Trace events include phase, label, timestamp, visibility, and optional detail.
- Browser snapshots hide dev-only events.
- Patch and invalidation region events are visible in traces.

Design-doc expectation:

- Trace should explain why UI changed from click to patch.
- It should capture validation, auth, effects, writes, invalidations, recomputation, and streamed patches.

Alignment grade: **Valid scaffold**.

Done properly:

- Trace is useful in the demo.
- Browser/dev visibility is the right first safety layer.
- Trace linkage to invalidated regions exists.

Remaining gaps:

- Trace still cannot describe an actual UI patch payload, only an invalidation notice and full projection stream.
- Trace IDs do not form a full causal graph across message, action, resource loader, projection region, patch, and host socket send.
- Trace events are manually emitted and therefore inconsistent across actions.
- Browser-safe policy is opt-in by event author discipline.

Recommended next move:

- Make patch delivery produce traceable patch IDs or region version IDs.
- Add trace tests that verify a user action can be followed from message to actual client-applied UI update.

### React Adapter

Current state:

- `connectProgramStream` is generic over message, projection, and trace types.
- `useProgramStream` wraps connection state, session, resume, projection, traces, results, errors, cursor, patches, and send.
- Approval UI uses the hook.
- The local deployment filter remains client-only state.

Design-doc expectation:

- React renders projections and hosts client islands.
- React should not own durable workflow state, data fetching, mutation, cache invalidation, or workflow truth.

Alignment grade: **Valid scaffold**.

Done properly:

- React no longer owns socket lifecycle directly in the demo.
- Local state remains local and non-durable.
- The hook does not introduce a query/cache model.

Shortcut/deviation notes:

- The adapter records `lastPatch` but does not apply patch payloads to visible UI.
- The hook depends on the `options` object identity; callers must memoize options to avoid reconnects.
- There are no mocked WebSocket/sessionStorage tests.
- There is no client-island protocol beyond ordinary React calling `send`.
- There is no renderer boundary that could accept UI-tree or Flight-style payloads.

Recommended next move:

- Stage 5 patch work must include the React adapter. A server patch model that the client cannot apply is still metadata.
- Add a small test harness for `connectProgramStream` or `useProgramStream` before making patch behavior complex.

### Bun Host

Current state:

- `serveBunProgram` builds the browser bundle, serves shell/assets, upgrades `/stream`, parses client envelopes, calls runtime, and sends returned envelopes.
- Demo `src/server.ts` only configures the approval runtime and host options.

Design-doc expectation:

- Bun is the first practical host.
- Bun should provide request/socket entrypoints and development story without becoming the whole architecture.

Alignment grade: **Done properly** for extraction, **valid scaffold** for live delivery.

Done properly:

- Demo-specific server plumbing is small.
- The framework has a host adapter boundary.

Remaining gaps:

- No session-to-socket registry.
- No cross-socket delivery after action-triggered invalidation.
- No dev server rebuild story beyond startup build plus Bun hot server.
- No alternative host contract is defined.

Recommended next move:

- Add host-level connected-session delivery before building serious live resource scenarios.
- Keep Bun-specific details in the adapter, not in runtime concepts.

### Demo

Current state:

- Deployment approvals demonstrate server-owned workflow state, fake auth, permissions, writes, audit, resource invalidation, session selection, trace panel state, resume, and local React state.

Design-doc expectation:

- The first demo should be a compact workflow console that proves the model and makes API-first design feel unnecessary inside the app.
- Later experiments mention incident timeline and AI task run scenarios.

Alignment grade: **Done properly** for current demo scope.

Done properly:

- The domain is the right kind of workflow.
- The browser does not call app-defined REST/RPC endpoints.
- Tests cover approval success and failure behavior.

Remaining gaps:

- The demo does not prove live external updates, long-running work, shared multi-user workflow, or process state resources.
- The UI still receives whole projection replacements.
- In-memory services are still durable truth for the demo.

Recommended next move:

- Do not expand the demo as the first Stage 5 step.
- After patch and delivery semantics are real, add one small incident/live-feed or AI-run slice to stress the new behavior.

### Tests

Current state:

- 28 tests pass.
- Tests include framework contract tests, runtime/protocol tests, and approval acceptance tests.
- Stage 4 added good coverage for resume, invalid messages, action validation/results, async-local observation, external invalidation, trace safety, and multi-screen routing.

Design-doc expectation:

- Tests should verify framework promises, not private implementation details.
- Demo tests should remain acceptance coverage.

Alignment grade: **Valid scaffold**.

Done properly:

- Fake-program contract tests are the right primary guardrail.
- Approval tests are domain acceptance tests, not the only proof.
- Current tests are fast and check clean.

Risky test coupling:

- Some tests assert exact envelope order. This will become brittle when action lifecycle events and patches evolve.
- Patch tests currently assert invalidated region metadata, not client-visible UI update semantics.
- Store tests still partly test adapters directly instead of only runtime behavior.

Missing high-value scenarios:

- Cross-socket action delivery.
- Client-applied patch behavior.
- Projection failure behavior.
- Resource loader failure behavior.
- Corrupted JSON store handling.
- Reconnect after patch-only updates.
- Same resource observed in multiple patch regions with different UI outputs.
- One region observing multiple resources.
- Client adapter cursor and resume behavior under mocked WebSocket.

Recommended next move:

- Build a black-box patch fixture that asserts observable stream/client behavior.
- Keep implementation details flexible so region-value patches, structural diffs, or UI-tree patches can all satisfy the same high-level contract.

### Docs

Current state:

- Design docs are still useful and coherent.
- README now describes features that are mostly true, but some wording is ahead of implementation.

Alignment grade: **Valid scaffold**.

Good:

- The docs preserve the project identity: durable server programs, not API/cache glue.
- The design tensions remain useful for Stage 5.

Docs ahead of implementation:

- "Runtime pushes patches to all affected clients" is only kernel-level true. Host-level cross-socket delivery is incomplete.
- "streams UI patch" is not yet literally true. Current patches are invalidation notices followed by whole projections.
- "Session-per-tab durable server session with reconnect + replay" is true for the prototype, but not production durability.

Recommended next move:

- After Stage 5 chooses the update model, update README and design status language to distinguish shipped behavior from intended behavior.

## UI Update Mechanism Review

This is the central Stage 5 decision. The design docs allow several patch models:

- serialized patches
- framework-specific UI trees
- React trees
- future React Flight adapter
- resource update notifications
- whole projection fallback

The current implementation is between models. It emits `projection:patch`, but the patch is only:

```txt
regions-invalidated -> full projection:update -> React re-render
```

That is a useful bridge, but it should not become the final mechanism by accident.

### Option 1: Region-Value Patches

Shape:

- `context.region(id, read)` returns and records a region value.
- Runtime stores the previous region outputs.
- When resources invalidate a region, runtime recomputes the screen or region and sends:

```txt
projection:patch {
  kind: "region-values",
  regions: [{ id, value, version, resources }]
}
```

- React adapter applies region values to the current projection without replacing everything.

Pros:

- Fits current region/resource observation model.
- Easier than UI-tree patches.
- Makes `projection:patch` honest: it carries replacement data.
- Keeps renderer independence better than React-specific payloads.
- Good test target: assert region value changed and unrelated region value stayed stable.

Cons:

- Requires projection structure to expose region boundaries.
- A region may not map cleanly to one field in an app-specific projection.
- If regions are only data fragments, the client still owns the merge logic.
- It may be a transitional model before UI-tree patches.

Risk:

- Medium. Strong next step if Stage 5 wants real patch behavior without adopting renderer internals.

### Option 2: Structural Projection Diffs

Shape:

- Runtime computes full old and new projections.
- Runtime sends JSON Patch, JSON Merge Patch, or custom structural diffs.
- Client applies diffs to projection state.

Pros:

- Minimal change to projection authoring.
- Easy to test at stream/client level.
- Can reduce payload size without designing region output APIs.
- Does not require React internals.

Cons:

- Diffs are implementation-derived, not semantic.
- Traces become less meaningful: "field changed" is weaker than "region X changed because resource Y invalidated."
- Can patch accidental projection shape instead of framework concepts.
- Does not help region-only recomputation.

Risk:

- Medium-high. Useful as a fallback or diagnostic, but weaker as the framework's identity.

### Option 3: Resource-Value Or Subscription Patches

Shape:

- Runtime streams changed resource values or resource invalidation events.
- Client or adapter updates subscribed UI from resource changes.

Pros:

- Natural fit for live feeds, process resources, and external updates.
- Resource graph becomes visibly valuable.
- Efficient for shared updates.

Cons:

- Risks recreating client cache ownership under a new name.
- UI still needs a projection/reconciliation model.
- Derived projection state can become split between server and client.

Risk:

- High if used as the main UI update model. Better as an internal input to server-side recomputation or as a later specialized stream lane.

### Option 4: Renderer/UI-Tree Patches Or Flight-Style Adapter

Shape:

- Server projection becomes a renderer payload: framework UI tree, React tree payload, or Flight-like stream.
- Runtime sends patches against UI tree boundaries.
- React adapter consumes renderer payloads instead of app-specific JSON projections.

Pros:

- Closest to the long-term design-doc phrase "streamed UI patch."
- Best fit for the strongest project identity: server program owns workflow and streams what UI should show.
- Could reduce app-written client merge logic.
- Could eventually support client/server component boundaries and richer React ecosystem compatibility.
- Makes traces compelling: click -> action -> resources -> region/UI node patch -> browser applied patch.

Cons:

- Hardest option.
- React Flight can force React's protocol to shape the kernel too early.
- A custom UI tree requires designing a renderer protocol, element model, event/message wiring, client islands, and hydration/update semantics.
- It may distract from resource graph and action model if attempted all at once.

Risk:

- High complexity, but strategically attractive. If the project is explicitly willing to try the hardest long-term approach, Stage 5 can plan a spike here.

Recommended framing:

- Do not jump directly to full Flight integration as the kernel.
- Do run a Stage 5 spike that defines the smallest framework-owned UI tree patch or Flight-style adapter boundary.
- Keep region-value patches as the fallback implementation route if the UI-tree spike proves too large.

### Option 5: Strengthened Full Projection Fallback

Shape:

- Keep full projections as normal behavior.
- Improve socket delivery, tests, resume, and trace.

Pros:

- Lowest complexity.
- Useful recovery path even if real patches exist.
- Good for initial correctness.

Cons:

- Does not move beyond the known scaffold.
- Conflicts with the design-doc direction if it stays central.
- Makes `projection:patch` decorative.

Risk:

- Low short-term, high architectural risk.

### Recommended Stage 5 Patch Direction

The strongest long-term option is a renderer/UI-tree patch or Flight-style adapter, but it should be approached as a bounded spike, not a rewrite of the whole framework.

Recommended Stage 5 sequence:

1. Define a patch contract at the stream/client boundary:
   - patches must be sufficient to update visible UI without a full projection update
   - patches must carry causality through cursor and trace
   - full projections remain recovery/fallback only
2. Spike the smallest framework-owned UI tree or Flight-style adapter boundary:
   - one screen
   - one action
   - one client-applied update
   - one client island or message event
3. In parallel or as fallback, design region-value patches:
   - use current `context.region` and resource observation
   - make region values patchable
   - keep renderer independence
4. Reject pure structural diffs as the primary identity unless the UI-tree spike fails and region-value patches prove too restrictive.

This keeps ambition high without pretending the hardest option is already understood.

## Contract Map

| Framework promise                                 | Current evidence                                          | Coverage status              | Remaining gap                               |
| ------------------------------------------------- | --------------------------------------------------------- | ---------------------------- | ------------------------------------------- |
| Browser sends framework messages, not app APIs    | `connectProgramStream`, Bun `/stream`, approval UI        | Runtime and acceptance tests | No browser/client adapter tests             |
| Program groups resources/actions/session/screens  | `defineProgram`, approval program, fake contract programs | Covered                      | Exact route matching only                   |
| Multi-screen registration exists                  | `screens`, `screenByRoute`                                | Covered                      | No route params or per-screen session model |
| Session state is separate from durable resources  | Approval session and tests                                | Covered                      | No schema/version policy                    |
| Resume restores or replays explicitly             | `connected.resume`, store replay                          | Covered                      | No retention/corruption/version tests       |
| Actions validate input before effects             | `defineAction(... accepts ...)`                           | Covered                      | Hand-written validators only                |
| Actions return typed JSON results                 | `action:result.result`                                    | Covered                      | Error/result schema still shallow           |
| Resources are observed during projection          | `ResourceGraph.observe`, async-local regions              | Covered                      | No loader failure or resource state model   |
| Invalidated resources map to regions              | `affectedRegions`, patch tests                            | Covered                      | Patch carries metadata, not UI replacement  |
| External invalidation fans out in kernel          | `runtime.invalidate`                                      | Covered                      | Host does not push to live sockets          |
| Action invalidation updates all affected browsers | Runtime can compute it                                    | Not covered                  | Missing host socket registry                |
| Trace has browser/dev visibility                  | `TraceVisibility`                                         | Covered                      | Manual discipline, no structured lifecycle  |
| React uses adapter hook                           | `useProgramStream`                                        | Demo uses it                 | No hook/client tests, no patch application  |
| Streamed UI patches are real                      | `projection:patch` exists                                 | Partially covered            | Missing actual UI patch payload/application |
| Renderer-agnostic pressure is preserved           | Kernel avoids React imports                               | Architectural only           | Projection shape is app JSON                |
| Live resource updates                             | `runtime.invalidate` can be called externally             | Partially covered            | No real subscription/source scenario        |
| Long-running process resources                    | Docs only                                                 | Not covered                  | Missing                                     |
| Client islands                                    | Local React filter only                                   | Manual/demo only             | No framework island protocol                |
| Effect capability graph                           | Effect exported and actions return Effect                 | Partially covered            | Services are plain objects                  |

## Stage 5 Recommended Queue

1. **Patch Model Decision And Spike**
   - Compare UI-tree/Flight-style adapter, region-value patches, and structural diffs in a small proof.
   - Produce one client-visible update without relying on full `projection:update`.
   - Keep full projection as recovery, not normal path.

2. **Host-Level Delivery**
   - Add a session-to-socket registry or delivery adapter to the Bun host.
   - Prove one action in one browser updates another connected browser observing the same resource.
   - Keep runtime/host responsibilities explicit.

3. **Patch-Aware React Adapter**
   - Make `useProgramStream` apply the chosen patch model.
   - Add mocked WebSocket/sessionStorage tests for cursor persistence, resume, error, and patch application.
   - Remove or downgrade `lastPatch` as passive state once patches drive UI.

4. **Trace From Action To Applied Patch**
   - Add trace details for patch identity, affected regions/UI nodes, and host delivery.
   - Ensure browser-safe trace snapshots remain safe by default.

5. **Resource And Failure Semantics**
   - Add resource loader failure and projection failure behavior.
   - Decide whether failures produce error envelopes, fallback projections, failed regions, or trace-only failures.
   - Keep tests black-box.

6. **API Ergonomics Pass**
   - Improve action validators, resource key builders, and screen/region authoring only after patch semantics are clearer.
   - Avoid polished APIs that encode the wrong update model.

7. **Next Demo Slice**
   - Add incident timeline or AI run only after patches and host delivery are real.
   - Use the new slice to prove live/shared/process-resource behavior, not just visual variety.

## Recommended Test Architecture For Stage 5

Keep:

- Fake-program framework contract tests.
- Approval demo acceptance tests.
- Fast Bun tests as the primary correctness layer.

Add:

- A black-box stream fixture that can connect multiple sessions and inspect delivered envelopes.
- A mocked client adapter fixture for WebSocket and `sessionStorage`.
- Patch contract tests that assert visible projection/UI state changes through patch application.
- Failure tests for projection throw, resource loader throw, invalid patch, stale cursor after patch-only update, and corrupted JSON store.

Avoid:

- Tests that depend on exact private recomputation strategy.
- Overfitting to approval UI field names.
- Broad browser E2E as the main patch correctness layer.

## Bottom Line

The framework is healthier after Stage 4. The old scaffold is no longer just metadata: resume, invalidation, traces, and regions now drive some runtime behavior.

The next danger is naming invalidation notices as patches and accidentally treating whole projection replacement as permanent architecture. The design docs point toward streamed UI updates. Stage 5 should make that real enough to test.

The ambitious path is worth exploring: a renderer/UI-tree patch or Flight-style adapter is the best long-term fit if it can be kept outside the kernel as an adapter boundary. Region-value patches are the strongest pragmatic fallback because they grow directly from the current resource/region model. Structural diffs are useful as a comparison point, but they should not become the framework identity unless the more semantic approaches fail.
