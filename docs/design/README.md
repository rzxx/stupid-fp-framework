# Design Doc Index

These documents expand the project proposal into an agent-context-oriented design set. They explain the system we want to explore, the mental model developers should have, the major runtime pieces, the experiments that should prove or disprove the idea, and the open questions we should keep visible.

The center of gravity is:

```txt
The app is a durable server program.
```

The secondary idea is:

```txt
Typed resources, actions, projections, and traces replace fetch/cache/API glue as the default
workflow app model.
```

Live views matter, but they are not the whole framework. A live view is a host optimization over a restorable `ViewContext`. Durable resources remain the source of truth, while UI state is view/editing context owned by the program.

The current semantic pivot is program-owned state versus renderer-owned state. Domain resources and
actions own durable workflow truth. `UIState` owns server-observed view/editing context. Renderer
state is outside the program and must be disposable.

Optimistic UI, pending input IDs, cursors, and reconnect state are protocol state. They are modeled
as adapter/runtime machinery, not app truth. Optimistic overlays are confirmed or rolled back by the
server projection, action result, and trace pipeline.

Resource cache identity must include scope when values vary by tenant, fanout scope, principal, or
custom permission context. Base-key invalidation should refresh all observed scoped variants first;
exact-scope invalidation is a later optimization.

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
- [../framework-state-review-6.md](../framework-state-review-6.md): review for patch protocol, routing/layouts, Bun-native dev DX, API syntax, and state placement rules.
- [../framework-state-review-7.md](../framework-state-review-7.md): Stage 10 semantic hardening for program/renderer state ownership, resource cache scopes, and trace-first positioning.
- [../framework-state-review-8.md](../framework-state-review-8.md): modular adoption direction for subpath exports, Promise-first APIs, and trace/resource/store standalone usage.
- [../stage-8-record.md](../stage-8-record.md): implementation record for invocation, recovery, scoped observation, and adapter contracts.
- [../stage-9-record.md](../stage-9-record.md): implementation record for Review 6 patch, routing, Bun asset, and builder API work.

## How To Use This Set

If you are starting a new planning or implementation task, read [model.md](model.md) first. Then load the specific context file for the work:

- API or ergonomics work: [developer-experience.md](developer-experience.md)
- stream, host, adapter, or architecture work: [runtime.md](runtime.md)
- prototype planning or scope control: [experiments.md](experiments.md)
- first implementation work: [../prototype-plan.md](../prototype-plan.md)
- current invocation/recovery/adapter pivot: [../stage-8-record.md](../stage-8-record.md)
- current patch/routing/dev/API direction: [../framework-state-review-6.md](../framework-state-review-6.md)
- current semantic hardening direction: [../framework-state-review-7.md](../framework-state-review-7.md)
- current modular adoption direction: [../framework-state-review-8.md](../framework-state-review-8.md)
- current implementation record: [../stage-9-record.md](../stage-9-record.md)

This is not a final implementation spec. The API sketches are illustrative. The goal is to keep the project understandable and buildable enough that each next planning step can focus on a prototype without losing the larger vision.
