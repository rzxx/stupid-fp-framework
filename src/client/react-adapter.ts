import { useEffect, useRef, useState } from "react";
import type {
  ActionResultEnvelope,
  ErrorEnvelope,
  ProgramStreamBootstrap,
  ProjectionPatchEnvelope,
  ResumeResult,
} from "../framework";
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

export type ProgramStreamReactState<TMessage, TProjection, TTrace> = {
  connection: ConnectionState;
  sessionId: string | null;
  resumed: boolean;
  resume: ResumeResult | null;
  projection: TProjection | null;
  projectionVersion: number;
  cursor: string | null;
  traces: TTrace[];
  lastResult: ActionResultEnvelope | null;
  lastError: ErrorEnvelope | null;
  lastPatch: ProjectionPatchEnvelope | null;
  send: (message: TMessage) => void;
};

export function useProgramStream<TMessage, TProjection, TTrace extends { traceId: string }>(
  options: ProgramStreamReactOptions<TProjection, TTrace>,
): ProgramStreamReactState<TMessage, TProjection, TTrace> {
  const stream = useRef<ProgramStreamClient<TMessage> | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(options.bootstrap?.sessionId ?? null);
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
  const [lastResult, setLastResult] = useState<ActionResultEnvelope | null>(null);
  const [lastError, setLastError] = useState<ErrorEnvelope | null>(null);
  const [lastPatch, setLastPatch] = useState<ProjectionPatchEnvelope | null>(null);

  useEffect(() => {
    stream.current = connectProgramStream<TMessage, TProjection, TTrace>({
      route: options.route,
      params: options.params,
      storageKey: options.storageKey,
      bootstrap: options.bootstrap,
      handlers: {
        onConnectionState: setConnection,
        onSession(nextSessionId, nextResumed, nextResume) {
          setSessionId(nextSessionId);
          setResumed(nextResumed);
          setResume(nextResume);
        },
        onProjection(envelope) {
          setProjection(envelope.projection);
          setProjectionVersion(envelope.projectionVersion);
          setCursor(envelope.cursor);

          if (options.projectionTraces) {
            setTraces((current) =>
              mergeTraces(current, options.projectionTraces?.(envelope.projection) ?? []),
            );
          }
        },
        onPatch(envelope) {
          setCursor(envelope.cursor);
          setLastPatch(envelope);

          if (!options.applyPatch) {
            setLastError({
              type: "error",
              sessionId: envelope.sessionId,
              message: "No projection patch applier configured",
            });
            return;
          }

          const applyPatch = options.applyPatch;

          setProjection((current) => {
            if (!current) {
              setLastError({
                type: "error",
                sessionId: envelope.sessionId,
                message: "Cannot apply projection patch before projection is available",
              });
              return current;
            }

            let next: TProjection;

            try {
              next = applyPatch(current, envelope);
            } catch (error) {
              setLastError({
                type: "error",
                sessionId: envelope.sessionId,
                message:
                  error instanceof Error ? error.message : "Failed to apply projection patch",
              });
              return current;
            }

            if (options.projectionTraces) {
              setTraces((traces) => mergeTraces(traces, options.projectionTraces?.(next) ?? []));
            }

            setProjectionVersion(envelope.projectionVersion);
            return next;
          });
        },
        onTrace(envelope) {
          setCursor(envelope.cursor);
          setTraces((current) => mergeTrace(current, envelope.trace));
        },
        onActionResult(envelope) {
          setCursor(envelope.cursor);
          setLastResult(envelope);
        },
        onError: setLastError,
      },
    });

    return () => stream.current?.close();
  }, [options]);

  return {
    connection,
    sessionId,
    resumed,
    resume,
    projection,
    projectionVersion,
    cursor,
    traces,
    lastResult,
    lastError,
    lastPatch,
    send(message) {
      stream.current?.send(message);
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
