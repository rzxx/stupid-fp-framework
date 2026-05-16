import { serveViteProgram } from "./vite";

const port = Number(Bun.env.PORT ?? 3000);

const server = await serveViteProgram({
  port,
  mode: Bun.env.NODE_ENV === "production" ? "production" : "development",
});

// eslint-disable-next-line no-console
console.log(`Deployment approvals prototype running at http://localhost:${server.port}`);
