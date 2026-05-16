import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  useProgramStream,
  type ProgramStreamReactOptions,
  type ProgramStreamReactState,
} from "./react-adapter";

type ProgramStreamContextValue = {
  stream: unknown;
  projectionReady: Promise<void>;
};

const ProgramStreamContext = createContext<ProgramStreamContextValue | null>(null);

export function ProgramStreamProvider<
  TInput extends { type: string },
  TProjection,
  TTrace extends { traceId: string },
>(props: { options: ProgramStreamReactOptions<TProjection, TTrace>; children: ReactNode }) {
  const stream = useProgramStream<TInput, TProjection, TTrace>(props.options);
  const deferred = useRef(createDeferred());

  useEffect(() => {
    if (stream.projection.value !== null) {
      deferred.current.resolve();
    }
  }, [stream.projection.value]);

  const value = useMemo<ProgramStreamContextValue>(
    () => ({
      stream,
      projectionReady: deferred.current.promise,
    }),
    [stream],
  );

  return <ProgramStreamContext value={value}>{props.children}</ProgramStreamContext>;
}

export function useProgramStreamState<
  TInput extends { type: string },
  TProjection,
  TTrace extends { traceId: string },
>(): ProgramStreamReactState<TInput, TProjection, TTrace> {
  const context = useProgramStreamContext();
  return context.stream as ProgramStreamReactState<TInput, TProjection, TTrace>;
}

export function useProgramProjection<TProjection>(options?: {
  suspense?: boolean;
}): TProjection | null {
  const context = useProgramStreamContext();
  const stream = context.stream as ProgramStreamReactState<
    { type: string },
    TProjection,
    { traceId: string }
  >;
  const projection = stream.projection.value;

  if (options?.suspense && projection === null) {
    throw context.projectionReady;
  }

  return projection;
}

export function useProgramActions<TInput extends { type: string }>() {
  return useProgramStreamState<TInput, unknown, { traceId: string }>().actions;
}

export function useProgramNavigation() {
  return useProgramStreamState<{ type: string }, unknown, { traceId: string }>().navigate;
}

export function useProgramErrors() {
  return useProgramStreamState<{ type: string }, unknown, { traceId: string }>().errors;
}

function useProgramStreamContext(): ProgramStreamContextValue {
  const context = useContext(ProgramStreamContext);

  if (!context) {
    throw new Error("Program stream hooks must be used inside ProgramStreamProvider");
  }

  return context;
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}
