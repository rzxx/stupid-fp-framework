import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseClientEnvelope, type ServerEnvelope } from "./framework";
import { createApprovalRuntime } from "./demo/approvals/program";
import type { ApprovalClientMessage, ApprovalProjection } from "./demo/approvals/types";

const root = import.meta.dir;
const outdir = join(root, "..", "dist");
const clientOut = join(outdir, "app.js");

await buildClient();

const runtime = createApprovalRuntime();
const port = Number(Bun.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/stream") {
      if (server.upgrade(request)) {
        return;
      }

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/client.js") {
      return new Response(Bun.file(clientOut), {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/styles.css") {
      return new Response(Bun.file(join(root, "client", "styles.css")), {
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    }

    return new Response(Bun.file(join(root, "shell.html")), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
  websocket: {
    async message(socket, payload) {
      const parsed = parseClientEnvelope<ApprovalClientMessage>(String(payload));

      if (parsed.type === "error") {
        socket.send(JSON.stringify(parsed));
        return;
      }

      const result =
        parsed.type === "connect" ? await runtime.connect(parsed) : await runtime.receive(parsed);

      sendAll(socket, result.envelopes);
    },
  },
});

console.log(`Deployment approvals prototype running at http://localhost:${server.port}`);

async function buildClient(): Promise<void> {
  await mkdir(dirname(clientOut), { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(root, "client", "app.tsx")],
    outdir,
    target: "browser",
    sourcemap: "inline",
    minify: false,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    throw new Error("Client build failed");
  }
}

function sendAll(
  socket: Bun.ServerWebSocket<unknown>,
  envelopes: ServerEnvelope<ApprovalProjection, ApprovalProjection["traces"][number]>[],
): void {
  for (const envelope of envelopes) {
    socket.send(JSON.stringify(envelope));
  }
}
