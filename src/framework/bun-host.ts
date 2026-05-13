import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseClientEnvelope, type ClientEnvelope, type ServerEnvelope } from "./stream";

export type BunRuntime<TMessage, TProjection, TTrace> = {
  connect: (
    envelope: Extract<ClientEnvelope<TMessage>, { type: "connect" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
  receive: (
    envelope: Extract<ClientEnvelope<TMessage>, { type: "message" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
};

export type BunProgramHostOptions<TMessage, TProjection, TTrace> = {
  runtime: BunRuntime<TMessage, TProjection, TTrace>;
  rootDir: string;
  clientEntry: string;
  shellPath: string;
  stylesPath?: string;
  outdir?: string;
  port?: number;
};

export async function serveBunProgram<TMessage, TProjection, TTrace>(
  options: BunProgramHostOptions<TMessage, TProjection, TTrace>,
): Promise<Bun.Server<unknown>> {
  const outdir = options.outdir ?? join(options.rootDir, "..", "dist");
  const clientOut = join(outdir, "app.js");

  await buildClient(options.clientEntry, outdir);

  return Bun.serve({
    port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/stream") {
        if (server.upgrade(request, { data: undefined })) {
          return;
        }

        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/client.js") {
        return new Response(Bun.file(clientOut), {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }

      if (url.pathname === "/styles.css" && options.stylesPath) {
        return new Response(Bun.file(options.stylesPath), {
          headers: { "Content-Type": "text/css; charset=utf-8" },
        });
      }

      return new Response(Bun.file(options.shellPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      async message(socket, payload) {
        const parsed = parseClientEnvelope<TMessage>(String(payload));

        if (parsed.type === "error") {
          socket.send(JSON.stringify(parsed));
          return;
        }

        const result =
          parsed.type === "connect"
            ? await options.runtime.connect(parsed)
            : await options.runtime.receive(parsed);

        sendAll(socket, result.envelopes);
      },
    },
  });
}

async function buildClient(entrypoint: string, outdir: string): Promise<void> {
  await mkdir(dirname(join(outdir, "app.js")), { recursive: true });

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    sourcemap: "inline",
    minify: false,
  });

  if (!result.success) {
    for (const log of result.logs) {
      // eslint-disable-next-line no-console
      console.error(log);
    }

    throw new Error("Client build failed");
  }
}

function sendAll<TProjection, TTrace>(
  socket: Bun.ServerWebSocket<unknown>,
  envelopes: ServerEnvelope<TProjection, TTrace>[],
): void {
  for (const envelope of envelopes) {
    socket.send(JSON.stringify(envelope));
  }
}
