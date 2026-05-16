import { defineConfig } from "vite";
import { stupidFpVite } from "./src/vite";

export default defineConfig({
  build: {
    outDir: "dist",
  },
  plugins: [
    stupidFpVite({
      template: "src/index.html",
      client: "src/demo/approvals/client/app.tsx",
      server: "src/demo/approvals/server.ts",
      reactCompiler: true,
    }),
  ],
});
