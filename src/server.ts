import { join } from "node:path";
import { serveViteProgram } from "./vite";

const root = import.meta.dir;
const port = Number(Bun.env.PORT ?? 3000);

const server = await serveViteProgram({
  root,
  template: join(root, "index.html"),
  clientEntry: join(root, "demo", "approvals", "client", "app.tsx"),
  serverEntry: join(root, "demo", "approvals", "server.ts"),
  reactCompiler: true,
  port,
  mode: Bun.env.NODE_ENV === "production" ? "production" : "development",
});

// eslint-disable-next-line no-console
console.log(`Deployment approvals prototype running at http://localhost:${server.port}`);
