# Design Doc Index

These documents expand the project proposal into an agent-context-oriented design set. They explain the system we want to explore, the mental model developers should have, the major runtime pieces, the experiments that should prove or disprove the idea, and the open questions we should keep visible.

The center of gravity is:

```txt
The app is a durable server program.
```

The secondary idea is:

```txt
Typed resources and actions replace fetch/cache/API glue as the default app model.
```

Live views matter, but they are not the whole framework. A live view is a host optimization over a restorable `ViewContext`. Durable resources remain the source of truth, while UI state is view/editing context that can be local-only or checkpointed when projection/resume needs it.

The current pivot is Domain + UI state. Domain state is durable workflow truth, modeled through
resources, actions, effects, and invalidation. UI state is view/editing context: local-first where
possible, checkpointed when a server projection or resume needs it, and promoted to domain state
when it becomes product truth.

The kernel should be able to restore a view checkpoint and process an input without depending on
process memory. Bun is the first host adapter, not the whole runtime model.

## Files

- [model.md](model.md): thesis, intended fit, and core vocabulary. This is the default context file for any agent.
- [developer-experience.md](developer-experience.md): developer mental model, workflow feature shape, and illustrative TypeScript API sketches.
- [runtime.md](runtime.md): runtime architecture, runtime flows, Bun host, custom stream, React adapter, RSC/Flight relationship, and renderer-agnostic pressure.
- [experiments.md](experiments.md): experiment phases, design tensions, non-goals, open questions, acceptance criteria, and next planning step.
- [../prototype-plan.md](../prototype-plan.md): concrete boundary for the first Bun + React deployment-approval vertical slice.
- [../kernel-hardening-plan.md](../kernel-hardening-plan.md): historical Stage 6 hardening scope.
- [../framework-state-review-3.md](../framework-state-review-3.md): Stage 6 audit and decision record for Effect-native services, API, plugins, persistence, and adapter boundaries.
- [../framework-state-review-5.md](../framework-state-review-5.md): Stage 8 pivot review for invocation contracts, client recovery, scoped observations, and adapter protocol.
- [../framework-state-review-6.md](../framework-state-review-6.md): current review for patch protocol, routing/layouts, Bun-native dev DX, API syntax, and state placement rules.
- [../stage-8-record.md](../stage-8-record.md): implementation record for invocation, recovery, scoped observation, and adapter contracts.

## How To Use This Set

If you are starting a new planning or implementation task, read [model.md](model.md) first. Then load the specific context file for the work:

- API or ergonomics work: [developer-experience.md](developer-experience.md)
- stream, host, adapter, or architecture work: [runtime.md](runtime.md)
- prototype planning or scope control: [experiments.md](experiments.md)
- first implementation work: [../prototype-plan.md](../prototype-plan.md)
- current invocation/recovery/adapter pivot: [../stage-8-record.md](../stage-8-record.md)
- current patch/routing/dev/API direction: [../framework-state-review-6.md](../framework-state-review-6.md)

This is not a final implementation spec. The API sketches are illustrative. The goal is to keep the project understandable and buildable enough that each next planning step can focus on a prototype without losing the larger vision.
