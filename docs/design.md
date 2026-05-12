# Design Docs: Durable Server Programs

This is the entrypoint for the second-stage design docs. The project explores webapps as durable server programs: browser events become typed messages, messages enter a server program, effects update durable resources, and UI projections stream back through a React-compatible adapter.

For the full design context, start with [docs/design/README.md](design/README.md).

## Reading Guide

- Read [model.md](design/model.md) first for the thesis, intended fit, and core vocabulary.
- Read [developer-experience.md](design/developer-experience.md) when working on API shape, examples, and ergonomics.
- Read [runtime.md](design/runtime.md) when working on the Bun host, stream, React adapter, RSC/Flight boundary, or architecture flow.
- Read [experiments.md](design/experiments.md) when planning prototypes, scope, risks, and open questions.
