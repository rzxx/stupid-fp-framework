import { join } from "node:path";
import { serveBunProgram } from "./bun";
import { JsonFileRuntimeStore } from "./store";
import type { TraceSnapshot } from "./trace";
import { createApprovalRuntime } from "./demo/approvals/program";
import type { ApprovalClientInput, ApprovalProjection } from "./demo/approvals/types";
import { renderApprovalApp } from "./demo/approvals/client/render-approval";

const root = import.meta.dir;
const runtime = createApprovalRuntime({
  store: Bun.env.RUNTIME_STORE_PATH
    ? new JsonFileRuntimeStore(Bun.env.RUNTIME_STORE_PATH)
    : undefined,
});
const port = Number(Bun.env.PORT ?? 3000);

const server = await serveBunProgram<ApprovalClientInput, ApprovalProjection, TraceSnapshot>({
  runtime,
  rootDir: root,
  clientEntry: join(root, "demo", "approvals", "client", "app.tsx"),
  shellPath: join(root, "shell.html"),
  client: {
    kind: "vite",
    root,
    reactCompiler: true,
  },
  port,
  dev: {
    watch: Bun.env.NODE_ENV !== "production",
  },
  initialRender: {
    resolve: (request) => resolveApprovalRoute(request),
    render: renderApprovalApp,
  },
});

// eslint-disable-next-line no-console
console.log(`Deployment approvals prototype running at http://localhost:${server.port}`);

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
