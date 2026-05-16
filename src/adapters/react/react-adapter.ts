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
import { applyRegionValuePatchAutomatically } from "./projection-patch";
export type ProgramStreamReactOptions<TProjection, TTrace> = {
  route: string;
  params: Record<string, string>;
  storageKey?: string;
  bootstrap?: ProgramStreamBootstrap<TProjection, TTrace>;
  projectionTraces?: (projection: TProjection) => TTrace[];
  applyPatch?: (projection: TProjection, envelope: ProjectionPatchEnvelope) => TProjection;
  router?: {
    mode: "history" | "hash";
  };
};

export type OptimisticProjectionUpdate<TProjection> = (projection: TProjection) => TProjection;

export type OptimisticInputOptions<TProjection> = {
  optimistic?: OptimisticProjectionUpdate<TProjection>;
  settle?: "projection" | "result";
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
  ui: {
    send: (input: TInput, options?: OptimisticInputOptions<TProjection>) => void;
  };
  actions: {
    run: (input: TInput, options?: OptimisticInputOptions<TProjection>) => void;
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
  send: (input: TInput, options?: OptimisticInputOptions<TProjection>) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
};

type OptimisticProjectionEntry<TProjection> = {
  update: OptimisticProjectionUpdate<TProjection>;
  settle: "projection" | "result";
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
  const confirmedProjectionRef = useRef<TProjection | null>(options.bootstrap?.projection ?? null);
  const optimisticProjectionRef = useRef<Record<string, OptimisticProjectionEntry<TProjection>>>(
    {},
  );
  const optimisticOrderRef = useRef<string[]>([]);
  const [projectionVersion, setProjectionVersion] = useState(
    options.bootstrap?.projectionVersion ?? 0,
  );
  const [cursor, setCursor] = useState<string | null>(options.bootstrap?.cursor ?? null);
  const [traces, setTraces] = useState<TTrace[]>(options.bootstrap?.traces ?? []);
  const [pendingInputs, setPendingInputs] = useState<Record<string, TInput>>({});
  const pendingInputsRef = useRef<Record<string, TInput>>({});
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
    pendingInputsRef.current = pendingInputs;
  }, [pendingInputs]);

  useEffect(() => {
    stream.current = connectProgramStream<TInput, TProjection, TTrace>({
      route,
      params,
      storageKey,
      bootstrap,
      handlers: {
        onConnectionState(nextConnection) {
          setConnection(nextConnection);

          if (nextConnection !== "closed" && nextConnection !== "error") {
            return;
          }

          const pendingCount = Object.keys(pendingInputsRef.current).length;
          clearOptimisticProjection();

          if (pendingCount === 0) {
            return;
          }

          pendingInputsRef.current = {};
          setPendingInputs({});
          setLastError({
            type: "error",
            message: `Stream ${nextConnection} with ${pendingCount} pending input(s); in-flight input recovery is not supported.`,
          });
        },
        onView(nextViewId, nextResumed, nextResume) {
          setViewId(nextViewId);
          setResumed(nextResumed);
          setResume(nextResume);
        },
        onProjection(envelope) {
          dropProjectionSettledOptimism();
          publishProjection(envelope.projection);
          setProjectionVersion(envelope.projectionVersion);
          setCursor(envelope.cursor);

          if (projectionTraces) {
            setTraces((current) => mergeTraces(current, projectionTraces(envelope.projection)));
          }
        },
        onPatch(envelope) {
          setLastPatch(envelope);

          const confirmed = confirmedProjectionRef.current;

          if (!confirmed) {
            setLastError({
              type: "error",
              viewId: envelope.viewId,
              message: "Cannot apply projection patch before projection is available",
            });
            return;
          }

          let next: TProjection;

          try {
            if (!patchProjection) {
              if (envelope.projectionManifestVersion !== undefined) {
                throw new Error(
                  `Projection patch requires manifest version ${envelope.projectionManifestVersion}, but no applyPatch option is configured`,
                );
              }

              next = applyRegionValuePatchAutomatically(confirmed, envelope);
            } else {
              next = patchProjection(confirmed, envelope);
            }
          } catch (error) {
            setLastError({
              type: "error",
              viewId: envelope.viewId,
              message: error instanceof Error ? error.message : "Failed to apply projection patch",
            });
            return;
          }

          setCursor(envelope.cursor);
          dropProjectionSettledOptimism();
          publishProjection(next);

          if (projectionTraces) {
            setTraces((traces) => mergeTraces(traces, projectionTraces(next)));
          }

          setProjectionVersion(envelope.projectionVersion);
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
            if (!envelope.ok) {
              removeOptimisticProjection(envelope.clientInputId);
            } else {
              removeResultSettledOptimism(envelope.clientInputId);
            }

            setPendingInputs((current) => {
              const next = { ...current };
              delete next[envelope.clientInputId as string];
              pendingInputsRef.current = next;
              return next;
            });
          }
        },
        onError: setLastError,
      },
    });

    return () => stream.current?.close();
  }, [route, params, storageKey, bootstrap, projectionTraces, patchProjection]);

  useEffect(() => {
    if (!options.router || options.router.mode !== "history") {
      return;
    }

    const onPopState = () => {
      stream.current?.navigate(window.location.pathname, { navigation: "pop" });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [options.router]);

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
    ui: {
      send(input, sendOptions) {
        sendProgramInput(input, sendOptions, false);
      },
    },
    actions: {
      run(input, actionOptions) {
        sendProgramInput(input, actionOptions, true);
      },
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
    send(input, sendOptions) {
      sendProgramInput(input, sendOptions, false);
    },
    navigate(path, navigateOptions) {
      if (options.router?.mode === "history") {
        const method = navigateOptions?.replace ? "replaceState" : "pushState";
        window.history[method](null, "", path);
      } else if (options.router?.mode === "hash") {
        window.location.hash = path;
      }

      stream.current?.navigate(path, {
        navigation:
          options.router?.mode === "hash" ? "hash" : navigateOptions?.replace ? "replace" : "push",
      });
    },
  };

  function sendProgramInput(
    input: TInput,
    inputOptions: OptimisticInputOptions<TProjection> | undefined,
    trackPending: boolean,
  ): void {
    const clientInputId = stream.current?.send(input);

    if (!clientInputId) {
      return;
    }

    if (inputOptions?.optimistic) {
      addOptimisticProjection(clientInputId, {
        update: inputOptions.optimistic,
        settle: inputOptions.settle ?? (trackPending ? "result" : "projection"),
      });
    }

    if (trackPending) {
      setPendingInputs((current) => {
        const next = { ...current, [clientInputId]: input };
        pendingInputsRef.current = next;
        return next;
      });
    }
  }

  function addOptimisticProjection(
    clientInputId: string,
    entry: OptimisticProjectionEntry<TProjection>,
  ): void {
    optimisticProjectionRef.current = {
      ...optimisticProjectionRef.current,
      [clientInputId]: entry,
    };
    optimisticOrderRef.current = [...optimisticOrderRef.current, clientInputId];
    republishOptimisticProjection();
  }

  function removeOptimisticProjection(clientInputId: string): void {
    if (!optimisticProjectionRef.current[clientInputId]) {
      return;
    }

    const next = { ...optimisticProjectionRef.current };
    delete next[clientInputId];
    optimisticProjectionRef.current = next;
    optimisticOrderRef.current = optimisticOrderRef.current.filter((id) => id !== clientInputId);
    republishOptimisticProjection();
  }

  function removeResultSettledOptimism(clientInputId: string): void {
    if (optimisticProjectionRef.current[clientInputId]?.settle !== "result") {
      return;
    }

    removeOptimisticProjection(clientInputId);
  }

  function dropProjectionSettledOptimism(): void {
    const next = { ...optimisticProjectionRef.current };
    let changed = false;

    for (const [clientInputId, entry] of Object.entries(next)) {
      if (entry.settle === "projection") {
        delete next[clientInputId];
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    optimisticProjectionRef.current = next;
    optimisticOrderRef.current = optimisticOrderRef.current.filter((id) => next[id]);
  }

  function clearOptimisticProjection(): void {
    if (optimisticOrderRef.current.length === 0) {
      return;
    }

    optimisticProjectionRef.current = {};
    optimisticOrderRef.current = [];
    republishOptimisticProjection();
  }

  function publishProjection(nextConfirmed: TProjection): void {
    confirmedProjectionRef.current = nextConfirmed;
    setProjection(applyOptimisticProjection(nextConfirmed));
  }

  function republishOptimisticProjection(): void {
    const confirmed = confirmedProjectionRef.current;

    if (!confirmed) {
      return;
    }

    setProjection(applyOptimisticProjection(confirmed));
  }

  function applyOptimisticProjection(confirmed: TProjection): TProjection {
    return optimisticOrderRef.current.reduce((current, clientInputId) => {
      const entry = optimisticProjectionRef.current[clientInputId];
      return entry ? entry.update(current) : current;
    }, confirmed);
  }
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
