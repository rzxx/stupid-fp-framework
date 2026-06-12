import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { stupidFp } from "./src/vite";

export default defineConfig({
  build: {
    outDir: "dist",
  },
  plugins: [
    tailwindcss(),
    stupidFp({
      template: "src/index.html",
      client: "src/demo/approvals/client/app.tsx",
      server: "src/demo/approvals/server.ts",
      reactCompiler: true,
    }),
  ],
});
