import { serveViteProgram } from "./vite";

const hostname = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 3000);

const server = await serveViteProgram({
  hostname,
  port,
  mode: process.env.NODE_ENV === "production" ? "production" : "development",
});

// eslint-disable-next-line no-console
console.log(`Deployment approvals prototype running at http://${hostname}:${server.port}`);
