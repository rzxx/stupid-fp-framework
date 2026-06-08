import { serveViteProgram } from "./vite";

const hostname = Bun.env.HOST ?? "localhost";
const port = Number(Bun.env.PORT ?? 3000);

const server = await serveViteProgram({
  hostname,
  port,
  mode: Bun.env.NODE_ENV === "production" ? "production" : "development",
});

// eslint-disable-next-line no-console
console.log(`Deployment approvals prototype running at http://${hostname}:${server.port}`);
