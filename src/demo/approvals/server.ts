import { JsonFileRuntimeStore } from "../../store";
import type { TraceSnapshot } from "../../trace";
import { createApprovalRuntime } from "./program";
import type { ApprovalClientInput, ApprovalProjection } from "./types";
import { renderApprovalApp } from "./client/render-approval";
import type { ViteProgramServerContext, ViteProgramHost } from "../../vite";

export function createProgramHost(
  _context: ViteProgramServerContext,
): ViteProgramHost<ApprovalClientInput, ApprovalProjection, TraceSnapshot> {
  return {
    runtime: createApprovalRuntime({
      store: Bun.env.RUNTIME_STORE_PATH
        ? new JsonFileRuntimeStore(Bun.env.RUNTIME_STORE_PATH)
        : undefined,
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
