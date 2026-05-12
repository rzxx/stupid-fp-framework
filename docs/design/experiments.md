# Experiments And Scope

This file contains the experiment phases, design tensions, non-goals, open questions, acceptance criteria, and next planning step. Use it for prototype planning and scope control. For vocabulary and thesis context, read [model.md](model.md) first.

## Experiment Phases

These are experiment phases, not a rigid product roadmap. Each phase should prove one claim and create evidence for what to do next.

### Phase 1: Static Concept Runtime

Claim:

```txt
The vocabulary works in TypeScript.
```

Build:

- minimal definitions for programs, screens, resources, actions, effects, and sessions
- in-memory resource loaders
- no real stream required
- one or two workflow-shaped examples

Success criteria:

- a workflow feature can be expressed without endpoint or fetch/cache language
- TypeScript can carry enough structure to make the model feel real
- the API sketch feels like a program, not a wrapper around React Query or RPC

Pivot questions:

- Does the model need fewer concepts?
- Are resources and actions clear enough?
- Does the effect style feel useful or heavy?

### Phase 2: Custom Stream Prototype

Claim:

```txt
A server message can produce a streamed UI patch without traditional SSR or API routes.
```

Build:

- Bun-hosted app shell
- simple browser-to-server stream
- simple server-to-browser patch format
- one interactive screen where a message changes server state and streams a patch

Success criteria:

- the browser sends framework messages, not app-defined API calls
- the server responds with a projection or patch
- the UI updates without manual client cache mutation

Pivot questions:

- Is the custom stream expressive enough?
- Does the patch format need to be semantic, component-based, or data-based?
- How much can React own without taking over the architecture?

### Phase 3: Resource Graph Prototype

Claim:

```txt
Typed resources and invalidation can replace fetch/cache soup.
```

Build:

- resource keys
- resource observation from screens
- invalidation from actions
- recomputation of affected projections
- trace entries for resource reads and invalidations

Success criteria:

- an action invalidates one or more resources
- only affected screen regions need to refresh conceptually
- the developer does not manually update a client cache

Pivot questions:

- What should resource keys look like?
- Should resources be entity-first, query-first, or both?
- How much dependency tracking should be automatic?

### Phase 4: Session Loop Prototype

Claim:

```txt
Per-tab conversational state can drive interactive UI while durable truth stays in resources.
```

Build:

- session creation per stream/tab
- session updates from messages
- session state included in projection
- clear distinction between resource state and session state

Success criteria:

- selected rows, panels, filters, or view modes can live in session state
- durable workflow state stays in resources
- losing a session does not corrupt app truth

Pivot questions:

- Which state keeps trying to become session state but should be durable?
- Does the session model feel like LiveView in a useful way?
- How much session state should be restorable?

### Phase 5: Workflow Console Demo

Claim:

```txt
The model can make a real-feeling operational app clearer.
```

Build:

- one compact workflow console with rotating micro-scenarios
- deployment approval for permissions and audit
- incident timeline for live updates and shared workflow state
- AI task run for long-running streaming progress

Success criteria:

- the demo makes API-first design feel unnecessary inside the app
- resource invalidation and server-owned state are visible
- React client widgets still fit naturally
- the project no longer feels like syntax novelty

Pivot questions:

- Which scenario best exposes the framework's value?
- Is the model too broad?
- Does the demo need one domain or a mixed operations console?

### Phase 6: Reconnect/Resume Spike

Claim:

```txt
The app can survive process or session death.
```

Build:

- reconnect cursor
- basic session snapshot or event history
- resource re-observation after reconnect
- fallback full projection refresh when replay is unavailable

Success criteria:

- a disconnected browser can reconnect and see a consistent workflow state
- important state survives through durable resources
- session-only state is either restored or gracefully reset

Pivot questions:

- Do we need event sourcing, snapshots, or both?
- What is the minimum resume story that proves serverless viability?
- Which host assumptions are Bun-specific and which are portable?

### Phase 7: Causal Trace Viewer

Claim:

```txt
The framework can explain why the UI changed.
```

Build:

- trace event schema
- trace IDs across messages, actions, effects, resources, and patches
- minimal trace panel or console output
- ability to inspect one user action end to end

Success criteria:

- a developer can follow one action from click to patch
- resource invalidations are visible
- effects and permission checks are visible enough to debug

Pivot questions:

- What is the smallest useful trace event?
- Should traces be always-on in dev?
- How much trace data is safe to expose to the browser?

### Phase 8: React Ecosystem Spike

Claim:

```txt
Normal React components can live inside the model without taking over the architecture.
```

Build:

- one representative client island
- one component with local UI behavior
- one component that sends framework messages
- clear boundary between client local state and server program state

Success criteria:

- React libraries are usable without rewriting them
- client islands can send typed messages
- the server program remains the owner of workflow state

Pivot questions:

- Where does React integration feel awkward?
- Do we need RSC or Flight sooner than expected?
- How should client-only components receive server projections?

## Design Tensions

### Custom Stream vs React Flight

Custom stream gives freedom. Flight gives ecosystem alignment.

Early direction:

```txt
Custom stream first. Flight later as an adapter if it helps.
```

The project should not let Flight decide the conceptual model before the model is tested.

### Server Session vs Serverless Reality

Live sessions are useful. Permanent memory is not safe.

Early direction:

```txt
Sessions are live conversational state. Resources are durable truth.
```

The framework should be comfortable with processes dying.

### FP Rigor vs TypeScript Usability

Typed effects are useful. Overly abstract APIs can make the framework feel like a puzzle.

Early direction:

```txt
Use FP ideas to clarify app ownership, effects, and data flow.
Do not make users perform FP rituals for their own sake.
```

### React Compatibility vs Framework Identity

React ecosystem support is important. Ordinary React app architecture is not the goal.

Early direction:

```txt
React renders and hosts client islands.
The server program owns workflow, resources, effects, and traces.
```

### Renderer-Agnostic Kernel vs First Useful App

A clean kernel could support other renderers later. Over-generalizing too early can kill momentum.

Early direction:

```txt
Design with adapter boundaries.
Build React web first.
```

## What We Are Not Building Yet

The project should avoid becoming:

- a Next.js clone
- a file-router-first framework
- a traditional SSR framework
- a generic API/RPC framework
- an ORM
- an auth product
- a CSS or component framework
- a deployment platform abstraction
- a wrapper around existing query/state libraries
- a custom language whose main value is syntax novelty

These things may become integrations or later conveniences. They are not the core.

## Open Questions

### Stream And Rendering

- How far can the custom stream go before React Flight or RSC compatibility becomes necessary?
- Should patches be UI-tree patches, resource-value patches, component payloads, or a mix?
- How much of the projection should be React-specific in the first prototype?
- Can the stream carry traces and patches together cleanly?

### Resource Graph

- What belongs in durable resources vs ephemeral sessions?
- Should resources model entities, queries, live feeds, and processes with one abstraction?
- How explicit should invalidation be?
- Can dependency tracking stay simple without becoming manual cache management again?

### Sessions And Resume

- What is the smallest useful reconnect story?
- Do sessions need snapshots, event logs, resource re-observation, or all three?
- How much session state should survive reconnect?
- What should happen when session restore fails?

### Effects And Actions

- How strict should the effect system be before it becomes annoying in TypeScript?
- Should services be provided through a real effect runtime, a lightweight custom abstraction, or adapters to libraries like Effect?
- How should action errors, validation failures, authorization failures, and retries appear in traces and UI?
- What optimistic UI model fits server-owned programs?

### Bun And Tooling

- What is the minimum Bun-native integration needed before this feels like a framework?
- How much can be plain TypeScript library code before a Bun plugin or compiler transform is needed?
- Which boundaries require build-time knowledge: client islands, server-only code, resource manifests, action registries, or route manifests?

### React Ecosystem

- What is the minimal client-island API?
- How should existing React components send messages?
- What common React patterns should be supported as escape hatches?
- What patterns should the framework discourage even if they remain possible?

### Product Shape

- Should the first demo be one mixed operations console or several small scenario demos?
- Which concept should the first public explanation lead with: server programs, resource graph, or LiveView-like sessions?
- How serious should early documentation sound if the project is still an experimental lab?

## Acceptance Criteria For This Design Direction

The project direction is coherent if a reader can answer:

- What are we building?
- Why is it not Next, Remix, LiveView, React Query, or RPC with nicer syntax?
- How does a user action flow through the system?
- What does React do?
- What does the framework kernel own?
- What state is durable?
- What state belongs to a session?
- What does the stream carry?
- What would the first prototypes prove?
- Which decisions are intentional and which are still open?

If those answers are unclear, the next step should be more design work, not implementation.

## Next Planning Step

The first-prototype plan now lives in [docs/prototype-plan.md](../prototype-plan.md).

That plan decides:

- the smallest runtime package shape
- the first workflow-shaped example
- the minimal custom stream
- the first resource/action/session API surface
- the success criteria for Phase 1 through Phase 3

It should not try to solve production deployment, full RSC compatibility, polished devtools, auth, database integrations, or a custom language.

The immediate goal is to make the server-program model run in a tiny but real form.
