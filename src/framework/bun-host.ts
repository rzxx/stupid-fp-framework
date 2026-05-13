import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseClientEnvelope,
  type ClientEnvelope,
  type ConnectedEnvelope,
  type ProgramStreamBootstrap,
  type ProjectionEnvelope,
  type ServerEnvelope,
  type TraceEnvelope,
} from "./stream";

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
  initialRender?: {
    resolve: (request: Request) =>
      | {
          route: string;
          params: Record<string, string>;
        }
      | undefined;
    render: (bootstrap: ProgramStreamBootstrap<TProjection, TTrace>) => string | Promise<string>;
  };
};

export async function serveBunProgram<TMessage, TProjection, TTrace>(
  options: BunProgramHostOptions<TMessage, TProjection, TTrace>,
): Promise<Bun.Server<unknown>> {
  const outdir = options.outdir ?? join(options.rootDir, "..", "dist");
  const clientOut = join(outdir, "app.js");
  const delivery = new SocketDelivery<TProjection, TTrace>();

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

      if (options.initialRender) {
        const route = options.initialRender.resolve(request);

        if (route) {
          const result = await options.runtime.connect({
            type: "connect",
            route: route.route,
            params: route.params,
          });
          const bootstrap = bootstrapFromEnvelopes(result.envelopes);
          const rendered = await options.initialRender.render(bootstrap);
          const shell = await Bun.file(options.shellPath).text();

          return new Response(injectInitialRender(shell, rendered, bootstrap), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      return htmlFile(options.shellPath);
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

        delivery.send(socket, result.envelopes);
      },
      close(socket) {
        delivery.close(socket);
      },
    },
  });
}

function bootstrapFromEnvelopes<TProjection, TTrace>(
  envelopes: ServerEnvelope<TProjection, TTrace>[],
): ProgramStreamBootstrap<TProjection, TTrace> {
  const connected = envelopes.find(
    (envelope): envelope is ConnectedEnvelope => envelope.type === "connected",
  );
  const projection = envelopes.find(
    (envelope): envelope is ProjectionEnvelope<TProjection> =>
      envelope.type === "projection:update",
  );

  if (!connected || !projection) {
    throw new Error("Initial render requires connected and projection envelopes");
  }

  return {
    sessionId: connected.sessionId,
    cursor: projection.cursor,
    resumed: connected.resumed,
    resume: connected.resume,
    projectionVersion: projection.projectionVersion,
    projection: projection.projection,
    traces: envelopes
      .filter((envelope): envelope is TraceEnvelope<TTrace> => envelope.type === "trace:update")
      .map((envelope) => envelope.trace),
  };
}

function injectInitialRender<TProjection, TTrace>(
  shell: string,
  html: string,
  bootstrap: ProgramStreamBootstrap<TProjection, TTrace>,
): string {
  const script = `<script>window.__STUPID_FP_BOOTSTRAP__=${serializeBootstrap(bootstrap)};</script>`;
  const root = '<div id="root"></div>';

  if (shell.includes(root)) {
    return shell.replace(root, `<div id="root">${html}</div>${script}`);
  }

  return shell.replace("</body>", `${script}</body>`);
}

function serializeBootstrap<TProjection, TTrace>(
  bootstrap: ProgramStreamBootstrap<TProjection, TTrace>,
): string {
  return JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
}

function htmlFile(path: string): Response {
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
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

class SocketDelivery<TProjection, TTrace> {
  readonly #sessionSockets = new Map<string, Set<Bun.ServerWebSocket<unknown>>>();
  readonly #socketSession = new WeakMap<Bun.ServerWebSocket<unknown>, string>();

  send(
    current: Bun.ServerWebSocket<unknown>,
    envelopes: ServerEnvelope<TProjection, TTrace>[],
  ): void {
    for (const envelope of envelopes) {
      if (envelope.type === "connected") {
        this.#attach(current, envelope.sessionId);
        current.send(JSON.stringify(envelope));
        continue;
      }

      if ("sessionId" in envelope && envelope.sessionId) {
        const sockets = this.#sessionSockets.get(envelope.sessionId);

        if (sockets && sockets.size > 0) {
          for (const socket of sockets) {
            socket.send(JSON.stringify(envelope));
          }

          continue;
        }
      }

      current.send(JSON.stringify(envelope));
    }
  }

  close(socket: Bun.ServerWebSocket<unknown>): void {
    const sessionId = this.#socketSession.get(socket);

    if (!sessionId) {
      return;
    }

    this.#socketSession.delete(socket);
    const sockets = this.#sessionSockets.get(sessionId);
    sockets?.delete(socket);

    if (sockets?.size === 0) {
      this.#sessionSockets.delete(sessionId);
    }
  }

  #attach(socket: Bun.ServerWebSocket<unknown>, sessionId: string): void {
    this.close(socket);

    let sockets = this.#sessionSockets.get(sessionId);

    if (!sockets) {
      sockets = new Set();
      this.#sessionSockets.set(sessionId, sockets);
    }

    sockets.add(socket);
    this.#socketSession.set(socket, sessionId);
  }
}
