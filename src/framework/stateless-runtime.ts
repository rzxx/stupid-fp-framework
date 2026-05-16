import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime";
import type { Program } from "./program";
import { TraceStore } from "./trace";

export type StatelessProgramFactory<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
> = () => Program<R, TUIState, TUIEvent, TActionInput, TProjection>;

export function createStatelessRuntime<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
>(
  createProgram: StatelessProgramFactory<R, TUIState, TUIEvent, TActionInput, TProjection>,
  options?: RuntimeOptions<TUIState, TProjection>,
): Runtime<TUIEvent, TActionInput, TProjection> {
  const traces = options?.traces ?? new TraceStore();
  const invocationOptions = { ...options, traces };

  return {
    get traces() {
      return traces;
    },
    connect(envelope) {
      return createRuntime(createProgram(), invocationOptions).connect(envelope);
    },
    receive(envelope) {
      return createRuntime(createProgram(), invocationOptions).receive(envelope);
    },
    affectedRegions(keys) {
      return createRuntime(createProgram(), invocationOptions).affectedRegions(keys);
    },
    invalidate(keys) {
      return createRuntime(createProgram(), invocationOptions).invalidate(keys);
    },
  };
}
