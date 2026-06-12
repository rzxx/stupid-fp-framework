import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { WebSocketServer } from "ws";
import type { HtmlTagDescriptor, Plugin, PluginOption, ViteDevServer } from "vite";
import {
  createProgramHostFromEntry,
  nodeRequestToRequest,
  sendNodeResponse,
  type ProgramHost,
  type ProgramRenderContext,
  type ProgramRoute,
  type ProgramRuntime,
  type ProgramServerContext,
  type ProgramServerEntry,
} from "../node";
import { parseClientEnvelope } from "../../framework/stream";
import type {
  ConnectedEnvelope,
  ProgramStreamBootstrap,
  ProjectionEnvelope,
  ServerEnvelope,
  TraceEnvelope,
} from "../../framework/stream";

export type {
  ProgramHost,
  ProgramRenderContext,
  ProgramRoute,
  ProgramRuntime,
  ProgramServerContext,
  ProgramServerEntry,
};

const pluginName = "stupid-fp-vite";
const metadataKey = "__stupidFpVite" as const;
const clientVirtualId = "virtual:stupid-fp/client";
const serverVirtualId = "virtual:stupid-fp/server";
const nodeRuntimeVirtualId = "virtual:stupid-fp/node-runtime";
const nodeServerVirtualId = "virtual:stupid-fp/node-server";
const resolvedClientVirtualId = `\0${clientVirtualId}`;
const resolvedServerVirtualId = `\0${serverVirtualId}`;
const resolvedNodeRuntimeVirtualId = `\0${nodeRuntimeVirtualId}`;
const resolvedNodeServerVirtualId = `\0${nodeServerVirtualId}`;

export type StupidFpOptions = {
  template?: string;
  client?: string;
  server?: string;
  reactCompiler?: boolean;
};

type RequiredPluginOptions = Required<Pick<StupidFpOptions, "template" | "client" | "server">> &
  Pick<StupidFpOptions, "reactCompiler">;

type StupidFpMetadata = {
  root: string;
  template: string;
  client: string;
  server: string;
  clientImportPath: string;
  serverImportPath: string;
  nodeRuntimePath: string;
  clientVirtualId: string;
  serverVirtualId: string;
  nodeServerVirtualId: string;
};

type StupidFpPlugin = Plugin & {
  [metadataKey]?: StupidFpMetadata;
};

export function stupidFp(options: StupidFpOptions = {}): PluginOption[] {
  const resolvedOptions = resolvePluginOptions(options);

  const frameworkPlugin: StupidFpPlugin = {
    name: pluginName,
    config() {
      return {
        appType: "custom",
        environments: {
          client: {
            build: {
              outDir: "dist/client",
              emptyOutDir: true,
              manifest: true,
              rolldownOptions: {
                input: [resolvedOptions.template, clientVirtualId],
              },
            },
          },
          ssr: {
            consumer: "server",
            dev: {
              moduleRunnerTransform: true,
            },
            build: {
              outDir: "dist/server",
              emptyOutDir: true,
              ssr: true,
              rolldownOptions: {
                input: nodeServerVirtualId,
                output: {
                  entryFileNames: "index.js",
                },
              },
            },
          },
        },
        server: {
          forwardConsole: true,
        },
      };
    },
    configResolved(config) {
      const frameworkPlugins = config.plugins.filter((plugin) => plugin.name === pluginName);

      if (frameworkPlugins.length !== 1) {
        throw new Error("Vite config must include exactly one stupidFp() plugin");
      }

      frameworkPlugin[metadataKey] = resolvePluginMetadata(config.root, resolvedOptions);
    },
    configureServer(server) {
      return configureFrameworkDevServer(server, () => frameworkPluginMetadata(frameworkPlugin));
    },
    resolveId(source) {
      if (source === clientVirtualId) {
        return resolvedClientVirtualId;
      }

      if (source === serverVirtualId) {
        return resolvedServerVirtualId;
      }

      if (source === nodeRuntimeVirtualId) {
        return resolvedNodeRuntimeVirtualId;
      }

      if (source === nodeServerVirtualId) {
        return resolvedNodeServerVirtualId;
      }

      return null;
    },
    load(id) {
      const metadata = frameworkPlugin[metadataKey];

      if (!metadata) {
        return null;
      }

      if (id === resolvedClientVirtualId) {
        return `import ${JSON.stringify(metadata.clientImportPath)};`;
      }

      if (id === resolvedServerVirtualId) {
        return `export * from ${JSON.stringify(metadata.serverImportPath)};`;
      }

      if (id === resolvedNodeRuntimeVirtualId) {
        return `export * from ${JSON.stringify(pathToFileURL(metadata.nodeRuntimePath).href)};`;
      }

      if (id === resolvedNodeServerVirtualId) {
        return nodeServerEntrySource(metadata);
      }

      return null;
    },
    transformIndexHtml(_html, context) {
      if (!context.server) {
        return [];
      }

      return [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: `/@id/${clientVirtualId}`,
          },
          injectTo: "body",
        } satisfies HtmlTagDescriptor,
      ];
    },
    async buildApp(builder) {
      await builder.build(builder.environments.client);
      await builder.build(builder.environments.ssr);
    },
  };
  const plugins: PluginOption[] = [frameworkPlugin, ...react()];

  if (resolvedOptions.reactCompiler) {
    plugins.push(babel({ presets: [reactCompilerPreset()] }));
  }

  return plugins;
}

function configureFrameworkDevServer(
  server: ViteDevServer,
  metadata: () => StupidFpMetadata,
): () => void {
  const delivery = new SocketDelivery<unknown, unknown>();
  const socketServer = new WebSocketServer({ noServer: true });
  let programPromise: Promise<PreparedDevProgram<unknown, unknown, unknown>> | null = null;

  function loadProgram() {
    programPromise ??= prepareDevProgram(server, metadata());
    return programPromise;
  }

  server.httpServer?.on("upgrade", (request, socket, head) => {
    const url = request.url ? new URL(request.url, requestUrlOrigin(request)) : null;

    if (url?.pathname !== "/stream") {
      return;
    }

    socketServer.handleUpgrade(request, socket, head, (socket) => {
      socketServer.emit("connection", socket, request);
    });
  });

  socketServer.on("connection", (socket) => {
    socket.on("message", async (payload) => {
      const program = await loadProgram();
      const host = await program.loadHost();
      const parsed = parseClientEnvelope<unknown>(rawSocketPayload(payload));

      if (parsed.type === "error") {
        socket.send(JSON.stringify(parsed));
        return;
      }

      const result =
        parsed.type === "connect"
          ? await host.runtime.connect(parsed)
          : await host.runtime.receive(parsed);

      delivery.send(socket, result.envelopes);
    });

    socket.on("close", () => {
      delivery.close(socket);
    });
  });

  server.httpServer?.on("close", () => {
    socketServer.close();
    void programPromise?.then((program) => program.close());
  });

  return () => {
    server.middlewares.use(async (nodeRequest, nodeResponse, next) => {
      if (!nodeRequest.url) {
        next();
        return;
      }

      const request = nodeRequestToRequest(nodeRequest);
      const url = new URL(request.url);

      if (url.pathname === "/stream") {
        await sendNodeResponse(
          nodeResponse,
          new Response("WebSocket upgrade required", { status: 400 }),
        );
        return;
      }

      if (hasUnsafePathSegment(url.pathname)) {
        await sendNodeResponse(nodeResponse, new Response("Bad request", { status: 400 }));
        return;
      }

      if (url.pathname.startsWith("/.vite/")) {
        await sendNodeResponse(nodeResponse, new Response("Not found", { status: 404 }));
        return;
      }

      const publicAsset = await serveFile(server.config.publicDir, request);

      if (publicAsset) {
        await sendNodeResponse(nodeResponse, publicAsset);
        return;
      }

      const program = await loadProgram();
      await sendNodeResponse(nodeResponse, await renderDevRequest(program, request));
    });
  };
}

type PreparedDevProgram<TInput, TProjection, TTrace> = {
  loadHost: () => Promise<ProgramHost<TInput, TProjection, TTrace>>;
  loadTemplate: () => Promise<string>;
  transformHtml: (request: Request, html: string) => Promise<string>;
  close: () => Promise<void>;
};

async function prepareDevProgram<TInput, TProjection, TTrace>(
  server: ViteDevServer,
  metadata: StupidFpMetadata,
): Promise<PreparedDevProgram<TInput, TProjection, TTrace>> {
  const vite = await import("vite");
  const runner = vite.createServerModuleRunner(server.environments.ssr);
  let cachedHost: ProgramHost<TInput, TProjection, TTrace> | null = null;

  server.watcher.on("change", () => {
    cachedHost = null;
    runner.clearCache();
    server.environments.client.hot.send({ type: "full-reload" });
  });

  const prepared: PreparedDevProgram<TInput, TProjection, TTrace> = {
    async loadHost() {
      if (cachedHost) {
        return cachedHost;
      }

      const mod = await runner.import<ProgramServerEntry<TInput, TProjection, TTrace>>(
        metadata.serverVirtualId,
      );
      cachedHost = await createProgramHostFromEntry(mod, {
        mode: "development",
        env: process.env,
        platform: "node",
      });
      return cachedHost;
    },
    async loadTemplate() {
      return readFile(metadata.template, "utf8");
    },
    async transformHtml(request, html) {
      return server.transformIndexHtml(new URL(request.url).pathname, html);
    },
    async close() {
      await runner.close();
    },
  };

  await prepared.loadHost();
  return prepared;
}

async function renderDevRequest<TInput, TProjection, TTrace>(
  program: PreparedDevProgram<TInput, TProjection, TTrace>,
  request: Request,
): Promise<Response> {
  const host = await program.loadHost();
  const route = await host.resolve?.(request);
  const template = await program.loadTemplate();

  if (route && host.render) {
    const result = await host.runtime.connect({
      type: "connect",
      route: route.route,
      params: route.params,
    });
    const bootstrap = bootstrapFromEnvelopes(result.envelopes);
    const rendered = await host.render(bootstrap, { request });

    return htmlResponse(
      await program.transformHtml(request, injectInitialRender(template, rendered, bootstrap)),
    );
  }

  return htmlResponse(await program.transformHtml(request, template));
}

function nodeServerEntrySource(metadata: StupidFpMetadata): string {
  return `
import {
  createNodeProgramHandler,
  startNodeProgramServer,
} from ${JSON.stringify(nodeRuntimeVirtualId)};
import * as entry from ${JSON.stringify(serverVirtualId)};

const baseOptions = {
  entry,
  mode: "production",
  clientOutDir: new URL("../client/", import.meta.url),
  templatePath: new URL(${JSON.stringify(`../client/${productionTemplatePath(metadata)}`)}, import.meta.url),
  manifestPath: new URL("../client/.vite/manifest.json", import.meta.url),
};

export function createHandler(overrides = {}) {
  return createNodeProgramHandler({ ...baseOptions, ...overrides });
}

export function start(options = {}) {
  return startNodeProgramServer({
    ...baseOptions,
    hostname: process.env.HOST ?? "localhost",
    port: Number(process.env.PORT ?? 3000),
    ...options,
  });
}

if (process.env.STUPID_FP_AUTOSTART !== "false") {
  const server = await start();
  const hostname = process.env.HOST ?? "localhost";
  console.log(\`stupid-fp server running at http://\${hostname}:\${server.port}\`);
}
`;
}

function productionTemplatePath(metadata: StupidFpMetadata): string {
  return relative(metadata.root, metadata.template).replaceAll(sep, "/");
}

function frameworkPluginMetadata(plugin: StupidFpPlugin): StupidFpMetadata {
  const metadata = plugin[metadataKey];

  if (!metadata) {
    throw new Error("stupidFp() plugin did not resolve its app metadata");
  }

  return metadata;
}

function resolvePluginOptions(options: StupidFpOptions): RequiredPluginOptions {
  return {
    template: options.template ?? "src/app.html",
    client: options.client ?? "src/entry.client.tsx",
    server: options.server ?? "src/entry.server.ts",
    reactCompiler: options.reactCompiler,
  };
}

function resolvePluginMetadata(root: string, options: RequiredPluginOptions): StupidFpMetadata {
  const template = resolve(root, options.template);
  const client = resolve(root, options.client);
  const server = resolve(root, options.server);
  const nodeRuntimePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../node.ts");

  return {
    root,
    template,
    client,
    server,
    nodeRuntimePath,
    clientImportPath: rootImportPath(root, client),
    serverImportPath: rootImportPath(root, server),
    clientVirtualId,
    serverVirtualId,
    nodeServerVirtualId,
  };
}

function rootImportPath(root: string, file: string): string {
  return `/${relative(root, file).replaceAll(sep, "/")}`;
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
  template: string,
  html: string,
  bootstrap: ProgramStreamBootstrap<TProjection, TTrace>,
): string {
  const script = `<script>window.__STUPID_FP_BOOTSTRAP__=${serializeBootstrap(bootstrap)};</script>`;
  const root = '<div id="root"></div>';

  if (template.includes(root)) {
    return template.replace(root, `<div id="root">${html}</div>${script}`);
  }

  return template.includes("</body>")
    ? template.replace("</body>", `${script}</body>`)
    : `${template}${script}`;
}

function serializeBootstrap<TProjection, TTrace>(
  bootstrap: ProgramStreamBootstrap<TProjection, TTrace>,
): string {
  return JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function serveFile(root: string, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  let pathname: string;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (pathname.includes("\0")) {
    return null;
  }

  const assetPath = resolve(root, `.${pathname}`);
  const routeToAsset = relative(root, assetPath);

  if (routeToAsset.startsWith("..") || isAbsolute(routeToAsset)) {
    return null;
  }

  const fileStat = await stat(assetPath).catch(() => null);

  if (!fileStat?.isFile()) {
    return null;
  }

  return new Response(await readFile(assetPath), {
    headers: { "Content-Type": contentType(pathname) },
  });
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (pathname.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }

  return "application/octet-stream";
}

function hasUnsafePathSegment(pathname: string): boolean {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }

  return decoded.includes("\0") || decoded.split("/").includes("..");
}

function requestUrlOrigin(request: { headers: { host?: string | string[] } }): string {
  const host = Array.isArray(request.headers.host)
    ? (request.headers.host[0] ?? "localhost")
    : (request.headers.host ?? "localhost");
  return `http://${host}`;
}

function rawSocketPayload(payload: import("ws").RawData): string {
  if (Array.isArray(payload)) {
    return Buffer.concat(payload).toString("utf8");
  }

  return Buffer.from(new Uint8Array(payload)).toString("utf8");
}

class SocketDelivery<TProjection, TTrace> {
  readonly #viewSockets = new Map<string, Set<import("ws").WebSocket>>();
  readonly #socketView = new WeakMap<import("ws").WebSocket, string>();

  send(socket: import("ws").WebSocket, envelopes: ServerEnvelope<TProjection, TTrace>[]): void {
    for (const envelope of envelopes) {
      const target = "viewId" in envelope ? envelope.viewId : undefined;

      if (envelope.type === "connected") {
        this.attach(socket, envelope.viewId);
      }

      if (!target) {
        socket.send(JSON.stringify(envelope));
        continue;
      }

      const sockets = this.#viewSockets.get(target);

      if (!sockets) {
        continue;
      }

      for (const targetSocket of sockets) {
        targetSocket.send(JSON.stringify(envelope));
      }
    }
  }

  close(socket: import("ws").WebSocket): void {
    const viewId = this.#socketView.get(socket);

    if (!viewId) {
      return;
    }

    const sockets = this.#viewSockets.get(viewId);

    sockets?.delete(socket);

    if (sockets?.size === 0) {
      this.#viewSockets.delete(viewId);
    }

    this.#socketView.delete(socket);
  }

  private attach(socket: import("ws").WebSocket, viewId: string): void {
    this.close(socket);

    const sockets = this.#viewSockets.get(viewId) ?? new Set<import("ws").WebSocket>();
    sockets.add(socket);
    this.#viewSockets.set(viewId, sockets);
    this.#socketView.set(socket, viewId);
  }
}
