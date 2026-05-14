import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime";
import type { Program } from "./program";

export type StatelessProgramFactory<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = () => Program<R, TUIState, TUIEvent, TActionMessage, TProjection>;

export function createStatelessRuntime<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  createProgram: StatelessProgramFactory<R, TUIState, TUIEvent, TActionMessage, TProjection>,
  options?: RuntimeOptions<TUIState, TProjection>,
): Runtime<TUIEvent, TActionMessage, TProjection> {
  return {
    get traces() {
      return createRuntime(createProgram(), options).traces;
    },
    connect(envelope) {
      return createRuntime(createProgram(), options).connect(envelope);
    },
    receive(envelope) {
      return createRuntime(createProgram(), options).receive(envelope);
    },
    affectedRegions(keys) {
      return createRuntime(createProgram(), options).affectedRegions(keys);
    },
    invalidate(keys) {
      return createRuntime(createProgram(), options).invalidate(keys);
    },
  };
}
