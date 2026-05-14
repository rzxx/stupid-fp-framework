import { join } from "node:path";
import { JsonFileRuntimeStore, serveBunProgram, type TraceSnapshot } from "./framework";
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
  stylesPath: join(root, "demo", "approvals", "client", "styles.css"),
  port,
  initialRender: {
    resolve: () => ({
      route: "/teams/:teamId/deployments",
      params: { teamId: "team-platform" },
    }),
    render: renderApprovalApp,
  },
});

// eslint-disable-next-line no-console
console.log(`Deployment approvals prototype running at http://localhost:${server.port}`);
