# Design Docs: Durable Server Programs

This is the entrypoint for the second-stage design docs. The project explores webapps as durable server programs: browser events become typed program inputs, inputs enter a server program, effects update durable domain resources, UI events update view state, and projections stream back through a React-compatible adapter.

For the full design context, start with [docs/design/README.md](design/README.md).

## Reading Guide

- Read [model.md](design/model.md) first for the thesis, intended fit, and core vocabulary.
- Read [developer-experience.md](design/developer-experience.md) when working on API shape, examples, and ergonomics.
- Read [runtime.md](design/runtime.md) when working on the Bun host, stream, React adapter, RSC/Flight boundary, or architecture flow.
- Read [experiments.md](design/experiments.md) when planning prototypes, scope, risks, and open questions.

The first vertical-slice implementation boundary is locked in [docs/prototype-plan.md](prototype-plan.md).

The current hardening stage is scoped in [docs/kernel-hardening-plan.md](kernel-hardening-plan.md).
