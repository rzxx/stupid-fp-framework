import { JsonFileRuntimeStore } from "../../store";
import type { TraceSnapshot } from "../../trace";
import { createApprovalRuntime } from "./program";
import type { ApprovalClientInput, ApprovalProjection } from "./types";
import { renderApprovalApp } from "./client/render-approval";
import type { ProgramHost, ProgramServerContext } from "../../node";

export function createProgramHost(
  context: ProgramServerContext,
): ProgramHost<ApprovalClientInput, ApprovalProjection, TraceSnapshot> {
  const runtimeStorePath = context.env.RUNTIME_STORE_PATH;

  return {
    runtime: createApprovalRuntime({
      store: runtimeStorePath ? new JsonFileRuntimeStore(runtimeStorePath) : undefined,
    }),
    resolve: resolveApprovalRoute,
    render: renderApprovalApp,
  };
}

function resolveApprovalRoute(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname === "/" ? "/teams/team-platform/deployments" : url.pathname;

  if (path === "/teams/team-platform/deployments" || path === "/teams/team-platform/runs") {
    return {
      route: path,
      params: {},
    };
  }

  return undefined;
}
