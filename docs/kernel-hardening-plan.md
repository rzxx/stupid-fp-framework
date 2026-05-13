# Kernel Hardening Plan

## Summary

The first prototype proved the vertical loop:

```txt
server program
-> browser message
-> action/effect transaction
-> resource invalidation
-> projection recompute
-> stream update
-> React UI
-> causal trace
```

The next stage should turn that working demo into a cleaner early framework kernel. The goal is not a new flashy demo. The goal is to harden the surfaces that future work will depend on: generic stream envelopes, an Effect-first action boundary, resource observation metadata, session-scoped traces, and framework contract tests.

## Decisions

### Keep Whole-Projection Updates

The prototype should continue sending `projection:update` envelopes that replace the current projection. Granular patch regions are a later design problem.

Reason:

- patch regions would force a UI diff/projection-region model before the resource graph is clear
- whole-projection updates are enough to prove server-owned workflow state
- the protocol name already leaves room for later incremental patches

### Add Resource Observation Metadata

The resource graph should track which `ResourceKey`s are read while a projection is computed.

Reason:

- this makes the resource graph more than a cache
- traces can explain observed resources and invalidated resources
- future patching, live resources, and resume logic need observation data

This stage should not yet add live subscriptions or per-region recomputation.

### Treat Effect As A Public Power Tool

Effect should remain part of the action authoring story. This project can be Effect-first without becoming just a wrapper around Effect.

Direction:

- expose a small `framework/effect.ts` boundary
- let actions return/use Effect values intentionally
- keep app concepts named as `Program`, `Action`, `Resource`, `Session`, `Projection`, `Stream`, and `Trace`
- keep browser/client contracts free of Effect types

### Scope Traces To Sessions

The current global trace list is useful for a demo, but it leaks history across sessions. Runtime projections should receive traces scoped to the current session.

Future global devtools can exist later as a separate surface.

## Implementation Work

- Make stream connect envelopes generic: `route: string`, `params: Record<string, string>`, optional `resumeCursor`.
- Add `framework/effect.ts` and route framework action Effect exports through it.
- Track resource reads during projection computation.
- Include observed resource metadata in trace events.
- Keep invalidation explicit and whole-projection recomputation.
- Move trace history from global projection output to session-specific trace history.
- Keep the deployment approval demo behavior unchanged.
- Add framework contract tests using a tiny fake program independent of the approvals demo.

## Test Focus

Add tests that describe framework promises rather than implementation functions:

- arbitrary route connects and produces an initial projection
- session messages change projection state without durable resource writes
- actions mutate durable fake state and invalidate observed resources
- failed actions do not mutate durable state
- projection computation records observed resources
- action traces record invalidated resources
- two sessions do not see each other's traces
- malformed envelopes are rejected while generic routes are accepted

Existing approval tests should stay as demo acceptance coverage.

## Non-Goals

- reconnect/resume
- multi-screen routing
- granular UI patching
- live resource subscriptions
- browser-flow automation as the primary test layer
- React Flight/RSC integration
- production persistence

## Completion Criteria

- `bun test` passes
- `bun run check` passes
- approval demo still works in the browser
- framework contract tests cover the new kernel behavior
- no app-specific route assumptions remain in the framework stream protocol
