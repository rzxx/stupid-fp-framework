import { defineConfig } from "vite";
import { stupidFpVite } from "./src/vite";

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
  },
  plugins: [
    stupidFpVite({
      template: "index.html",
      client: "demo/approvals/client/app.tsx",
      server: "demo/approvals/server.ts",
      reactCompiler: true,
    }),
  ],
});
