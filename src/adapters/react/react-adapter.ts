import { useEffect, useRef, useState } from "react";
import type {
  ActionResultEnvelope,
  ActionLifecycleEnvelope,
  ErrorEnvelope,
  ProgramStreamBootstrap,
  ProjectionPatchEnvelope,
  ResumeResult,
} from "../../framework";
import {
  connectProgramStream,
  type ConnectionState,
  type ProgramStreamClient,
} from "./program-stream";

export type ProgramStreamReactOptions<TProjection, TTrace> = {
  route: string;
  params: Record<string, string>;
  storageKey?: string;
  bootstrap?: ProgramStreamBootstrap<TProjection, TTrace>;
  projectionTraces?: (projection: TProjection) => TTrace[];
  applyPatch?: (projection: TProjection, envelope: ProjectionPatchEnvelope) => TProjection;
};

export type ProgramStreamReactState<TInput, TProjection, TTrace> = {
  connection: {
    status: ConnectionState;
  };
  view: {
    id: string | null;
    resumed: boolean;
    resume: ResumeResult | null;
    cursor: string | null;
  };
  projection: {
    value: TProjection | null;
    version: number;
  };
  traces: {
    visible: TTrace[];
  };
  actions: {
    pendingInputs: Record<string, TInput>;
    lastLifecycle: ActionLifecycleEnvelope | null;
    lastResult: ActionResultEnvelope | null;
  };
  errors: {
    last: ErrorEnvelope | null;
  };
  diagnostics: {
    lastPatch: ProjectionPatchEnvelope | null;
  };
  send: (input: TInput) => void;
};

export function useProgramStream<TInput, TProjection, TTrace extends { traceId: string }>(
  options: ProgramStreamReactOptions<TProjection, TTrace>,
): ProgramStreamReactState<TInput, TProjection, TTrace> {
  const stream = useRef<ProgramStreamClient<TInput> | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [viewId, setViewId] = useState<string | null>(options.bootstrap?.viewId ?? null);
  const [resumed, setResumed] = useState(options.bootstrap?.resumed ?? false);
  const [resume, setResume] = useState<ResumeResult | null>(options.bootstrap?.resume ?? null);
  const [projection, setProjection] = useState<TProjection | null>(
    options.bootstrap?.projection ?? null,
  );
  const [projectionVersion, setProjectionVersion] = useState(
    options.bootstrap?.projectionVersion ?? 0,
  );
  const [cursor, setCursor] = useState<string | null>(options.bootstrap?.cursor ?? null);
  const [traces, setTraces] = useState<TTrace[]>(options.bootstrap?.traces ?? []);
  const [pendingInputs, setPendingInputs] = useState<Record<string, TInput>>({});
  const [lastLifecycle, setLastLifecycle] = useState<ActionLifecycleEnvelope | null>(null);
  const [lastResult, setLastResult] = useState<ActionResultEnvelope | null>(null);
  const [lastError, setLastError] = useState<ErrorEnvelope | null>(null);
  const [lastPatch, setLastPatch] = useState<ProjectionPatchEnvelope | null>(null);
  const {
    route,
    params,
    storageKey,
    bootstrap,
    projectionTraces,
    applyPatch: patchProjection,
  } = options;

  useEffect(() => {
    stream.current = connectProgramStream<TInput, TProjection, TTrace>({
      route,
      params,
      storageKey,
      bootstrap,
      handlers: {
        onConnectionState: setConnection,
        onView(nextViewId, nextResumed, nextResume) {
          setViewId(nextViewId);
          setResumed(nextResumed);
          setResume(nextResume);
        },
        onProjection(envelope) {
          setProjection(envelope.projection);
          setProjectionVersion(envelope.projectionVersion);
          setCursor(envelope.cursor);

          if (projectionTraces) {
            setTraces((current) => mergeTraces(current, projectionTraces(envelope.projection)));
          }
        },
        onPatch(envelope) {
          setCursor(envelope.cursor);
          setLastPatch(envelope);

          if (!patchProjection) {
            setLastError({
              type: "error",
              viewId: envelope.viewId,
              message: "No projection patch applier configured",
            });
            return;
          }

          setProjection((current) => {
            if (!current) {
              setLastError({
                type: "error",
                viewId: envelope.viewId,
                message: "Cannot apply projection patch before projection is available",
              });
              return current;
            }

            let next: TProjection;

            try {
              next = patchProjection(current, envelope);
            } catch (error) {
              setLastError({
                type: "error",
                viewId: envelope.viewId,
                message:
                  error instanceof Error ? error.message : "Failed to apply projection patch",
              });
              return current;
            }

            if (projectionTraces) {
              setTraces((traces) => mergeTraces(traces, projectionTraces(next)));
            }

            setProjectionVersion(envelope.projectionVersion);
            return next;
          });
        },
        onTrace(envelope) {
          setCursor(envelope.cursor);
          setTraces((current) => mergeTrace(current, envelope.trace));
        },
        onActionLifecycle(envelope) {
          setCursor(envelope.cursor);
          setLastLifecycle(envelope);
        },
        onActionResult(envelope) {
          setCursor(envelope.cursor);
          setLastResult(envelope);

          if (envelope.clientInputId) {
            setPendingInputs((current) => {
              const next = { ...current };
              delete next[envelope.clientInputId as string];
              return next;
            });
          }
        },
        onError: setLastError,
      },
    });

    return () => stream.current?.close();
  }, [route, params, storageKey, bootstrap, projectionTraces, patchProjection]);

  return {
    connection: {
      status: connection,
    },
    view: {
      id: viewId,
      resumed,
      resume,
      cursor,
    },
    projection: {
      value: projection,
      version: projectionVersion,
    },
    traces: {
      visible: traces,
    },
    actions: {
      pendingInputs,
      lastLifecycle,
      lastResult,
    },
    errors: {
      last: lastError,
    },
    diagnostics: {
      lastPatch,
    },
    send(input) {
      const clientInputId = stream.current?.send(input);

      if (clientInputId) {
        setPendingInputs((current) => ({ ...current, [clientInputId]: input }));
      }
    },
  };
}

function mergeTrace<TTrace extends { traceId: string }>(current: TTrace[], next: TTrace): TTrace[] {
  const withoutNext = current.filter((trace) => trace.traceId !== next.traceId);
  return [next, ...withoutNext];
}

function mergeTraces<TTrace extends { traceId: string }>(
  current: TTrace[],
  next: TTrace[],
): TTrace[] {
  return [...next].reverse().reduce((traces, trace) => mergeTrace(traces, trace), current);
}
