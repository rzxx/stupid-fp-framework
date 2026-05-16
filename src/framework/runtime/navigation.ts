import type { InvocationContextValue } from "../invocation";
import type { ServerEnvelope } from "../stream";
import type { TraceSnapshot, TraceStore } from "../trace";
import type { ViewContext } from "../view";
import { runtimeResult, type RuntimeResult } from "./delivery";

export type NavigateInput = {
  type: "system.navigate";
  path: string;
  params?: Record<string, string>;
  navigation?: "push" | "replace" | "pop" | "hash";
};

export async function navigate<TUIState, TProjection>(input: {
  view: ViewContext<TUIState>;
  navigation: NavigateInput;
  invocation: InvocationContextValue;
  traces: TraceStore;
  resolveRoute: (
    route: string,
    params: Record<string, string>,
  ) => Promise<{ route: string; params: Record<string, string> } | null>;
  scopedFanout: (
    route: string,
    params: Record<string, string>,
    invocation: InvocationContextValue,
  ) => string;
  project: (
    viewId: string,
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ) => Promise<RuntimeResult<TProjection>>;
  traceEnvelope: (
    view: ViewContext<TUIState>,
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ) => Promise<ServerEnvelope<TProjection, TraceSnapshot>>;
}): Promise<RuntimeResult<TProjection>> {
  const trace = input.traces.start(input.navigation.type, {
    scopeId: input.view.viewId,
  });
  const resolved = await input.resolveRoute(input.navigation.path, input.navigation.params ?? {});

  if (!resolved) {
    input.traces.fail(trace, `No screen registered for route: ${input.navigation.path}`);
    return runtimeResult([
      {
        type: "error",
        viewId: input.view.viewId,
        traceId: trace.traceId,
        message: `No screen registered for route: ${input.navigation.path}`,
      },
      await input.traceEnvelope(input.view, trace, input.invocation),
    ]);
  }

  input.traces.add(trace, "system", "navigation resolved", {
    path: input.navigation.path,
    route: resolved.route,
    navigation: input.navigation.navigation ?? "push",
  });
  input.view.route = resolved.route;
  input.view.params = resolved.params;
  input.view.fanoutScope = input.scopedFanout(
    input.view.route,
    input.view.params,
    input.invocation,
  );
  input.invocation.fanoutScope = input.view.fanoutScope;
  input.view.principal = input.invocation.principal;

  const projected = await input.project(input.view.viewId, trace, input.invocation);

  if (trace.status !== "error") {
    input.traces.complete(trace);
  }

  return runtimeResult([
    ...projected.envelopes,
    await input.traceEnvelope(input.view, trace, input.invocation),
  ]);
}

export function isNavigateInput(value: unknown): value is NavigateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return (
    input.type === "system.navigate" &&
    typeof input.path === "string" &&
    (input.params === undefined || isStringRecord(input.params)) &&
    (input.navigation === undefined || isNavigationMethod(input.navigation))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isNavigationMethod(value: unknown): value is NavigateInput["navigation"] {
  return value === "push" || value === "replace" || value === "pop" || value === "hash";
}
