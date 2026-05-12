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

Live sessions matter, but they are not the whole framework. A live session is the active conversation between one browser tab and the server program. Durable resources remain the source of truth.

## Files

- [model.md](model.md): thesis, intended fit, and core vocabulary. This is the default context file for any agent.
- [developer-experience.md](developer-experience.md): developer mental model, workflow feature shape, and illustrative TypeScript API sketches.
- [runtime.md](runtime.md): runtime architecture, runtime flows, Bun host, custom stream, React adapter, RSC/Flight relationship, and renderer-agnostic pressure.
- [experiments.md](experiments.md): experiment phases, design tensions, non-goals, open questions, acceptance criteria, and next planning step.

## How To Use This Set

If you are starting a new planning or implementation task, read [model.md](model.md) first. Then load the specific context file for the work:

- API or ergonomics work: [developer-experience.md](developer-experience.md)
- stream, host, adapter, or architecture work: [runtime.md](runtime.md)
- prototype planning or scope control: [experiments.md](experiments.md)

This is not a final implementation spec. The API sketches are illustrative. The goal is to keep the project understandable and buildable enough that each next planning step can focus on a prototype without losing the larger vision.
