import { join } from "node:path";
import { buildViteProgram } from "./vite";

const root = import.meta.dir;

await buildViteProgram({
  root,
  template: join(root, "index.html"),
  clientEntry: join(root, "demo", "approvals", "client", "app.tsx"),
  serverEntry: join(root, "demo", "approvals", "server.ts"),
  reactCompiler: true,
  mode: "production",
});
