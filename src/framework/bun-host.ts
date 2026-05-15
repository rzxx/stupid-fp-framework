import { watch, type FSWatcher } from "node:fs";
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

type BunSocketData = { kind: "stream" | "reload" };

export type BunRuntime<TInput, TProjection, TTrace> = {
  connect: (
    envelope: Extract<ClientEnvelope<TInput>, { type: "connect" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
  receive: (
    envelope: Extract<ClientEnvelope<TInput>, { type: "input" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
};

export type BunProgramHostOptions<TInput, TProjection, TTrace> = {
  runtime: BunRuntime<TInput, TProjection, TTrace>;
  rootDir: string;
  clientEntry: string;
  shellPath: string;
  stylesPath?: string;
  outdir?: string;
  port?: number;
  dev?: {
    watch?: boolean;
  };
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

export async function serveBunProgram<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
): Promise<Bun.Server<BunSocketData>> {
  const outdir = options.outdir ?? join(options.rootDir, "..", "dist");
  const clientOut = join(outdir, "app.js");
  const delivery = new SocketDelivery<TProjection, TTrace>();
  const reload = new DevReloadDelivery();

  await buildClient(options.clientEntry, outdir);
  const watchers = options.dev?.watch ? watchClient(options, outdir, reload) : [];

  const server = Bun.serve<BunSocketData>({
    port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/stream") {
        if (server.upgrade(request, { data: { kind: "stream" as const } })) {
          return;
        }

        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/__stupid_fp_reload" && options.dev?.watch) {
        if (server.upgrade(request, { data: { kind: "reload" as const } })) {
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

          return new Response(
            injectDevReload(injectInitialRender(shell, rendered, bootstrap), options),
            {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }
      }

      const shell = await Bun.file(options.shellPath).text();
      return new Response(injectDevReload(shell, options), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      async message(socket, payload) {
        if (socket.data?.kind === "reload") {
          return;
        }

        const parsed = parseClientEnvelope<TInput>(String(payload));

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
      open(socket) {
        if (socket.data?.kind === "reload") {
          reload.open(socket);
        }
      },
      close(socket) {
        if (socket.data?.kind === "reload") {
          reload.close(socket);
          return;
        }

        delivery.close(socket);
      },
    },
  });
  const stop = server.stop.bind(server);

  server.stop = ((closeActiveConnections?: boolean) => {
    for (const watcher of watchers) {
      watcher.close();
    }

    stop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
}

function injectDevReload(html: string, options: { dev?: { watch?: boolean } }): string {
  if (!options.dev?.watch || html.includes("__stupid_fp_reload")) {
    return html;
  }

  const script = `<script type="module">
const socket = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/__stupid_fp_reload");
socket.addEventListener("message", () => location.reload());
</script>`;

  return html.includes("</body>")
    ? html.replace("</body>", `${script}</body>`)
    : `${html}${script}`;
}

function watchClient<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
  reload: DevReloadDelivery,
): FSWatcher[] {
  let pending: unknown = null;
  const watched = new Set([options.clientEntry, options.stylesPath].filter(isString).map(dirname));
  const rebuild = () => {
    if (pending !== null) {
      clearTimeout(pending as ReturnType<typeof setTimeout>);
    }

    pending = setTimeout(() => {
      pending = null;
      void buildClient(options.clientEntry, outdir).then(() => reload.reload());
    }, 40);
  };

  return [...watched].map((path) => watch(path, { recursive: true }, rebuild));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
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
    viewId: connected.viewId,
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

class DevReloadDelivery {
  readonly #sockets = new Set<Bun.ServerWebSocket<unknown>>();

  open(socket: Bun.ServerWebSocket<unknown>): void {
    this.#sockets.add(socket);
  }

  close(socket: Bun.ServerWebSocket<unknown>): void {
    this.#sockets.delete(socket);
  }

  reload(): void {
    for (const socket of this.#sockets) {
      socket.send("reload");
    }
  }
}

class SocketDelivery<TProjection, TTrace> {
  readonly #viewsockets = new Map<string, Set<Bun.ServerWebSocket<unknown>>>();
  readonly #socketview = new WeakMap<Bun.ServerWebSocket<unknown>, string>();

  send(
    current: Bun.ServerWebSocket<unknown>,
    envelopes: ServerEnvelope<TProjection, TTrace>[],
  ): void {
    for (const envelope of envelopes) {
      if (envelope.type === "connected") {
        this.#attach(current, envelope.viewId);
        current.send(JSON.stringify(envelope));
        continue;
      }

      if ("viewId" in envelope && envelope.viewId) {
        const sockets = this.#viewsockets.get(envelope.viewId);

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
    const viewId = this.#socketview.get(socket);

    if (!viewId) {
      return;
    }

    this.#socketview.delete(socket);
    const sockets = this.#viewsockets.get(viewId);
    sockets?.delete(socket);

    if (sockets?.size === 0) {
      this.#viewsockets.delete(viewId);
    }
  }

  #attach(socket: Bun.ServerWebSocket<unknown>, viewId: string): void {
    this.close(socket);

    let sockets = this.#viewsockets.get(viewId);

    if (!sockets) {
      sockets = new Set();
      this.#viewsockets.set(viewId, sockets);
    }

    sockets.add(socket);
    this.#socketview.set(socket, viewId);
  }
}
