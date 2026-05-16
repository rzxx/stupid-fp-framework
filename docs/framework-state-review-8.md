# Framework State Review 8

## Purpose

This record sets the first modular adoption direction. The framework still centers on durable
server programs, but the public surface should no longer force users to buy the full idea before
they can benefit from any part of it.

## Decision

Keep one package and expose opt-in subpath entrypoints:

```txt
stupid-fp-framework/trace
stupid-fp-framework/resource
stupid-fp-framework/store
stupid-fp-framework/stream
stupid-fp-framework/patch
stupid-fp-framework/react
stupid-fp-framework/runtime
stupid-fp-framework/bun
stupid-fp-framework/effect
```

The root package remains the full framework barrel for prototypes and demos.

## Adoption Ladder

The first standalone proof should be trace, resource tracking, and runtime stores.

Developers should be able to adopt:

- traces only, for browser-safe causal records
- resource keys and observation tracking, without defining a `Program`
- runtime stores, for checkpoint/envelope/cursor experiments
- stream and patch protocol pieces, for adapter experiments
- React or Bun adapters, only when those hosts are useful
- the full durable-program runtime, when they want the whole model

## Promise-First API

Effect remains the internal execution substrate and the advanced authoring API. The first
effect-free path is Promise authoring:

- `Resource.define(...).load(...)`
- `ResourceGraph.readAsync(...)`
- `ResourceGraph.regionAsync(...)`
- `Action.define(...).input(...).run(...)`
- `Screen.define(...).project(...)`

Effect-native authoring remains available through explicit names:

- `Resource.define(...).loadEffect(...)`
- `Action.define(...).input(...).runEffect(...)`
- `Screen.define(...).projectEffect(...)`
- `Action.reject(...)`

This is additive. Existing Effect-native APIs stay valid.

## Boundary Rules

Adapters must not import the full framework barrel. React should depend on stream, patch, and
projection protocol types directly. Bun should stay behind the Bun entrypoint. Effect should stay
behind the Effect entrypoint except where full-runtime declarations intentionally expose it.

The shared observation/protocol types are factored out so resource tracking, projection regions,
view checkpoints, stores, and plugins can share shapes without creating core dependency cycles.

## Verification Direction

The modular contract is healthy when:

- each subpath can be imported directly
- trace/resource/store examples work without importing Program, React, Bun, or Effect
- Promise resources and actions run through the existing runtime
- adapter imports do not reference the full framework barrel
- public core modules do not form dependency cycles
- `bun run check` and `bun test` pass

## Bottom Line

The project should sell a ladder, not a cliff:

```txt
trace -> resource tracking -> stores/stream/patches -> adapters -> full durable program
```

The full idea remains available, but the first useful experience can be much smaller.
