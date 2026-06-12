import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type {
  Connect,
  HtmlTagDescriptor,
  Plugin,
  PluginOption,
  ResolvedConfig,
  ViteDevServer,
} from "vite";
import {
  parseClientEnvelope,
  type ClientEnvelope,
  type ConnectedEnvelope,
  type ProgramStreamBootstrap,
  type ProjectionEnvelope,
  type ServerEnvelope,
  type TraceEnvelope,
} from "../../framework/stream";

const pluginName = "stupid-fp-vite";
const metadataKey = "__stupidFpVite" as const;
const clientVirtualId = "virtual:stupid-fp/client";
const serverVirtualId = "virtual:stupid-fp/server";
const resolvedClientVirtualId = `\0${clientVirtualId}`;
const resolvedServerVirtualId = `\0${serverVirtualId}`;

export type ViteRuntime<TInput, TProjection, TTrace> = {
  connect: (
    envelope: Extract<ClientEnvelope<TInput>, { type: "connect" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
  receive: (
    envelope: Extract<ClientEnvelope<TInput>, { type: "input" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
};

export type ViteProgramRoute = {
  route: string;
  params: Record<string, string>;
};

export type ViteProgramHost<TInput, TProjection, TTrace> = {
  runtime: ViteRuntime<TInput, TProjection, TTrace>;
  resolve?: (
    request: Request,
  ) => ViteProgramRoute | undefined | Promise<ViteProgramRoute | undefined>;
  render?: (
    bootstrap: ProgramStreamBootstrap<TProjection, TTrace>,
    context: ViteProgramRenderContext,
  ) => string | Promise<string>;
};

export type ViteProgramRenderContext = {
  request: Request;
};

export type ViteProgramServerEntry<TInput, TProjection, TTrace> = {
  createProgramHost: (
    context: ViteProgramServerContext,
  ) =>
    | ViteProgramHost<TInput, TProjection, TTrace>
    | Promise<ViteProgramHost<TInput, TProjection, TTrace>>;
};

export type ViteProgramServerContext = {
  mode: "development" | "production";
  env: Record<string, string | undefined>;
  platform: "node";
};

export type ViteProgramOptions = {
  configFile?: string;
  hostname?: string;
  port?: number;
  mode?: "development" | "production";
};

export type ProgramServer = {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
};

export type StupidFpViteOptions = {
  template?: string;
  client?: string;
  server?: string;
  reactCompiler?: boolean;
};

type StupidFpViteMetadata = {
  root: string;
  template: string;
  client: string;
  server: string;
  clientImportPath: string;
  serverImportPath: string;
  clientVirtualId: string;
  serverVirtualId: string;
};

type StupidFpVitePlugin = Plugin & {
  [metadataKey]?: StupidFpViteMetadata;
};

export function stupidFp(options: StupidFpViteOptions = {}): PluginOption[] {
  return stupidFpVite(options);
}

export function stupidFpVite(options: StupidFpViteOptions = {}): PluginOption[] {
  const resolvedOptions = resolvePluginOptions(options);

  const frameworkPlugin: StupidFpVitePlugin = {
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
                input: serverVirtualId,
                output: {
                  entryFileNames: "entry-server.js",
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
      frameworkPlugin[metadataKey] = resolvePluginMetadata(config, resolvedOptions);
    },
    configureServer(server) {
      const delivery = new SocketDelivery<unknown, unknown>();
      const socketServer = new WebSocketServer({ noServer: true });
      let programPromise: Promise<PreparedProgram<unknown, unknown, unknown>> | null = null;

      function loadProgram() {
        programPromise ??= prepareDevelopmentProgramFromServer(server, frameworkPluginMetadata());
        return programPromise;
      }

      function frameworkPluginMetadata(): StupidFpViteMetadata {
        const metadata = frameworkPlugin[metadataKey];

        if (!metadata) {
          throw new Error("stupidFpVite() plugin did not resolve its app metadata");
        }

        return metadata;
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

          const publicAsset = await serveViteFile(server.config.publicDir, request);

          if (publicAsset) {
            await sendNodeResponse(nodeResponse, publicAsset);
            return;
          }

          const program = await loadProgram();
          await sendNodeResponse(nodeResponse, await renderProgramRequest(program, request));
        });
      };
    },
    resolveId(source) {
      if (source === clientVirtualId) {
        return resolvedClientVirtualId;
      }

      if (source === serverVirtualId) {
        return resolvedServerVirtualId;
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
      const metadata = frameworkPlugin[metadataKey] ?? findStupidFpViteMetadata(builder.config);
      const outDir = resolvedOutDir(builder.config);

      await builder.build(builder.environments.client);
      await builder.build(builder.environments.ssr);
      await writeProductionServerEntrypoint(outDir, metadata);
    },
  };
  const plugins: PluginOption[] = [frameworkPlugin, ...react()];

  if (resolvedOptions.reactCompiler) {
    plugins.push(babel({ presets: [reactCompilerPreset()] }));
  }

  return plugins;
}

export async function buildViteProgram(
  options: Omit<ViteProgramOptions, "port"> = {},
): Promise<void> {
  const previousNodeEnv = process.env.NODE_ENV;
  const { vite, app, config } = await resolveViteProgramConfig("build", {
    ...options,
    mode: options.mode ?? "production",
  });
  const outDir = resolvedOutDir(config);
  const clientOutDir = join(outDir, "client");
  const serverOutDir = join(outDir, "server");

  if (!previousNodeEnv) {
    process.env.NODE_ENV = "production";
  }

  try {
    await vite.build({
      configFile: config.configFile,
      mode: options.mode ?? "production",
      appType: "custom",
      build: {
        outDir: clientOutDir,
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: {
          input: [app.template, app.clientVirtualId],
        },
      },
    });

    await vite.build({
      configFile: config.configFile,
      mode: options.mode ?? "production",
      appType: "custom",
      build: {
        outDir: serverOutDir,
        emptyOutDir: true,
        ssr: true,
        rolldownOptions: {
          input: app.serverVirtualId,
          output: {
            entryFileNames: "entry-server.js",
          },
        },
      },
    });
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

export async function serveViteProgram<TInput, TProjection, TTrace>(
  options: ViteProgramOptions = {},
): Promise<ProgramServer> {
  const mode = options.mode ?? "development";
  const delivery = new SocketDelivery<TProjection, TTrace>();
  const resolved = await resolveViteProgramConfig(mode === "production" ? "build" : "serve", {
    ...options,
    mode,
  });
  const outDir = resolvedOutDir(resolved.config);
  const program = await prepareProgram<TInput, TProjection, TTrace>(resolved, outDir, mode);
  const socketServer = new WebSocketServer({ noServer: true });
  const httpServer = createHttpServer(async (nodeRequest, nodeResponse) => {
    try {
      const request = nodeRequestToRequest(nodeRequest);
      const url = new URL(request.url);

      if (hasUnsafePathSegment(url.pathname)) {
        await sendNodeResponse(nodeResponse, new Response("Bad request", { status: 400 }));
        return;
      }

      if (url.pathname.startsWith("/.vite/")) {
        await sendNodeResponse(nodeResponse, new Response("Not found", { status: 404 }));
        return;
      }

      if (url.pathname === "/stream") {
        await sendNodeResponse(
          nodeResponse,
          new Response("WebSocket upgrade required", { status: 400 }),
        );
        return;
      }

      if (await program.serveNodeRequest?.(nodeRequest, nodeResponse)) {
        return;
      }

      const asset = await program.serveAsset(request);

      if (asset) {
        await sendNodeResponse(nodeResponse, asset);
        return;
      }

      await sendNodeResponse(nodeResponse, await renderProgramRequest(program, request));
    } catch (error) {
      await program.close();
      nodeResponse.statusCode = 500;
      nodeResponse.end(error instanceof Error ? error.message : "Internal server error");
    }
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ? new URL(request.url, requestUrlOrigin(request)) : null;

    if (url?.pathname !== "/stream") {
      socket.destroy();
      return;
    }

    socketServer.handleUpgrade(request, socket, head, (socket) => {
      socketServer.emit("connection", socket, request);
    });
  });

  socketServer.on("connection", (socket) => {
    socket.on("message", async (payload) => {
      const host = await program.loadHost();
      const parsed = parseClientEnvelope<TInput>(rawSocketPayload(payload));

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

  try {
    await listen(httpServer, options.port ?? 0, options.hostname);
  } catch (error) {
    await program.close();
    throw error;
  }

  program.printUrls();

  return {
    get port() {
      const address = httpServer.address();

      if (!address || typeof address === "string") {
        throw new Error("Expected Vite program server to bind a TCP port");
      }

      return address.port;
    },
    stop(closeActiveConnections?: boolean) {
      void program.close();
      socketServer.close();

      if (closeActiveConnections) {
        httpServer.closeAllConnections();
      }

      httpServer.close();
    },
  };
}

type PreparedProgram<TInput, TProjection, TTrace> = {
  loadHost: () => Promise<ViteProgramHost<TInput, TProjection, TTrace>>;
  loadTemplate: (request: Request) => Promise<string>;
  transformHtml: (request: Request, html: string) => Promise<string>;
  serveAsset: (request: Request) => Promise<Response | null>;
  serveNodeRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  printUrls: () => void;
  close: () => Promise<void>;
};

type ResolvedViteProgramConfig = {
  vite: typeof import("vite");
  config: ResolvedConfig;
  app: StupidFpViteMetadata;
};

type RequiredPluginOptions = Required<Pick<StupidFpViteOptions, "template" | "client" | "server">> &
  Pick<StupidFpViteOptions, "reactCompiler">;

async function prepareProgram<TInput, TProjection, TTrace>(
  resolved: ResolvedViteProgramConfig,
  outDir: string,
  mode: "development" | "production",
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  return mode === "production"
    ? prepareProductionProgram(resolved, outDir)
    : prepareDevelopmentProgram(resolved);
}

async function prepareDevelopmentProgram<TInput, TProjection, TTrace>(
  resolved: ResolvedViteProgramConfig,
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  const server = await resolved.vite.createServer({
    configFile: resolved.config.configFile,
    mode: resolved.config.mode,
    appType: "custom",
    clearScreen: false,
    logLevel: process.env.NODE_ENV === "test" ? "error" : "info",
    server: {
      middlewareMode: true,
      hmr: false,
      strictPort: false,
      forwardConsole: true,
    },
    environments: {
      ssr: {
        dev: {
          moduleRunnerTransform: true,
        },
      },
    },
  });

  const runner = resolved.vite.createServerModuleRunner(server.environments.ssr);
  let cachedHost: ViteProgramHost<TInput, TProjection, TTrace> | null = null;

  server.watcher.on("change", () => {
    cachedHost = null;
    runner.clearCache();
    server.environments.client.hot.send({ type: "full-reload" });
  });

  const prepared: PreparedProgram<TInput, TProjection, TTrace> = {
    async loadHost() {
      if (cachedHost) {
        return cachedHost;
      }

      const mod = await runner.import<ViteProgramServerEntry<TInput, TProjection, TTrace>>(
        resolved.app.serverVirtualId,
      );
      cachedHost = await createProgramHostFromModule(mod, "development");
      return cachedHost;
    },
    async loadTemplate() {
      return readFile(resolved.app.template, "utf8");
    },
    async transformHtml(request, html) {
      return server.transformIndexHtml(new URL(request.url).pathname, html);
    },
    async serveAsset() {
      return null;
    },
    async serveNodeRequest(request, response) {
      const url = request.url ? new URL(request.url, requestUrlOrigin(request)) : null;

      if (
        !url ||
        (!isViteAssetPath(url.pathname) &&
          !(await isPublicAssetRequest(server.config.publicDir, url.pathname)))
      ) {
        return false;
      }

      return serveViteMiddleware(server.middlewares, request, response);
    },
    printUrls() {},
    async close() {
      await runner.close();
      await server.close();
    },
  };

  try {
    await prepared.loadHost();
  } catch (error) {
    await prepared.close();
    throw error;
  }

  return prepared;
}

async function prepareDevelopmentProgramFromServer<TInput, TProjection, TTrace>(
  server: ViteDevServer,
  app: StupidFpViteMetadata,
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  const vite = await import("vite");
  const runner = vite.createServerModuleRunner(server.environments.ssr);
  let cachedHost: ViteProgramHost<TInput, TProjection, TTrace> | null = null;

  server.watcher.on("change", () => {
    cachedHost = null;
    runner.clearCache();
    server.environments.client.hot.send({ type: "full-reload" });
  });

  const prepared: PreparedProgram<TInput, TProjection, TTrace> = {
    async loadHost() {
      if (cachedHost) {
        return cachedHost;
      }

      const mod = await runner.import<ViteProgramServerEntry<TInput, TProjection, TTrace>>(
        app.serverVirtualId,
      );
      cachedHost = await createProgramHostFromModule(mod, "development");
      return cachedHost;
    },
    async loadTemplate() {
      return readFile(app.template, "utf8");
    },
    async transformHtml(request, html) {
      return server.transformIndexHtml(new URL(request.url).pathname, html);
    },
    async serveAsset() {
      return null;
    },
    printUrls() {},
    async close() {
      await runner.close();
    },
  };

  await prepared.loadHost();
  return prepared;
}

async function prepareProductionProgram<TInput, TProjection, TTrace>(
  resolved: ResolvedViteProgramConfig,
  outDir: string,
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  const clientOutDir = join(outDir, "client");
  const serverEntry = join(outDir, "server", "entry-server.js");
  const manifestPath = join(clientOutDir, ".vite", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    ViteManifestEntry
  >;
  const manifestEntry = resolveManifestEntry(manifest);
  const templatePath = resolveProductionTemplatePath(clientOutDir, resolved.app, manifest);
  let productionHostPromise: Promise<ViteProgramHost<TInput, TProjection, TTrace>> | null = null;

  if (!manifestEntry) {
    throw new Error("Vite client build did not produce a manifest entry");
  }

  const prepared: PreparedProgram<TInput, TProjection, TTrace> = {
    async loadHost() {
      productionHostPromise ??= import(pathToFileURL(serverEntry).href).then((mod) =>
        createProgramHostFromModule(
          mod as ViteProgramServerEntry<TInput, TProjection, TTrace>,
          "production",
        ),
      );
      return productionHostPromise;
    },
    async loadTemplate() {
      return readFile(templatePath, "utf8");
    },
    async transformHtml(_request, html) {
      return injectViteProductionAssets(html, manifest, manifestEntry);
    },
    async serveAsset(request) {
      return serveViteProductionAsset(clientOutDir, request);
    },
    printUrls() {},
    async close() {
      return undefined;
    },
  };

  await prepared.loadHost();
  return prepared;
}

async function renderProgramRequest<TInput, TProjection, TTrace>(
  program: PreparedProgram<TInput, TProjection, TTrace>,
  request: Request,
): Promise<Response> {
  const host = await program.loadHost();
  const route = await host.resolve?.(request);
  const template = await program.loadTemplate(request);

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

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function createProgramHostFromModule<TInput, TProjection, TTrace>(
  mod: Partial<ViteProgramServerEntry<TInput, TProjection, TTrace>>,
  mode: "development" | "production",
): Promise<ViteProgramHost<TInput, TProjection, TTrace>> {
  if (typeof mod.createProgramHost !== "function") {
    throw new Error("Vite server entry must export createProgramHost(context)");
  }

  return mod.createProgramHost({ mode, env: process.env, platform: "node" });
}

async function resolveViteProgramConfig(
  command: "build" | "serve",
  options: Omit<ViteProgramOptions, "port">,
): Promise<ResolvedViteProgramConfig> {
  const vite = await import("vite");
  const mode =
    options.mode ?? (command === "build" ? ("production" as const) : ("development" as const));
  const config = await vite.resolveConfig(
    {
      configFile: options.configFile,
      mode,
    },
    command,
    mode,
  );
  const app = findStupidFpViteMetadata(config);

  return { vite, config, app };
}

function findStupidFpViteMetadata(config: ResolvedConfig): StupidFpViteMetadata {
  const plugins = config.plugins.filter(isStupidFpVitePlugin);

  if (plugins.length === 0) {
    throw new Error("Vite config must include exactly one stupidFpVite() plugin");
  }

  if (plugins.length > 1) {
    throw new Error("Vite config includes multiple stupidFpVite() plugins");
  }

  const metadata = plugins[0]?.[metadataKey];

  if (!metadata) {
    throw new Error("stupidFpVite() plugin did not resolve its app metadata");
  }

  return metadata;
}

function isStupidFpVitePlugin(plugin: Plugin): plugin is StupidFpVitePlugin {
  return plugin.name === pluginName;
}

function resolvePluginOptions(options: StupidFpViteOptions): RequiredPluginOptions {
  return {
    template: options.template ?? "src/app.html",
    client: options.client ?? "src/entry.client.tsx",
    server: options.server ?? "src/entry.server.ts",
    reactCompiler: options.reactCompiler,
  };
}

function resolvePluginMetadata(
  config: ResolvedConfig,
  options: RequiredPluginOptions,
): StupidFpViteMetadata {
  const template = resolve(config.root, options.template);
  const client = resolve(config.root, options.client);
  const server = resolve(config.root, options.server);

  return {
    root: config.root,
    template,
    client,
    server,
    clientImportPath: rootImportPath(config.root, client),
    serverImportPath: rootImportPath(config.root, server),
    clientVirtualId,
    serverVirtualId,
  };
}

function resolvedOutDir(config: ResolvedConfig): string {
  return isAbsolute(config.build.outDir)
    ? config.build.outDir
    : resolve(config.root, config.build.outDir);
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

type ViteManifestEntry = {
  file: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
};

function resolveManifestEntry(
  manifest: Record<string, ViteManifestEntry>,
): ViteManifestEntry | null {
  const entries = Object.values(manifest).filter((entry) => entry.isEntry);

  if (entries.length === 1) {
    return entries[0] ?? null;
  }

  return null;
}

function resolveProductionTemplatePath(
  clientOutDir: string,
  app: StupidFpViteMetadata,
  manifest: Record<string, ViteManifestEntry>,
): string {
  const relativeTemplate = relative(app.root, app.template);

  if (!relativeTemplate.startsWith("..") && !isAbsolute(relativeTemplate)) {
    return join(clientOutDir, relativeTemplate);
  }

  const manifestTemplate = Object.keys(manifest).find((key) => key.endsWith(".html"));

  if (!manifestTemplate) {
    throw new Error("Vite client build did not produce a template HTML entry");
  }

  return join(clientOutDir, manifestTemplate);
}

function isViteAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@react-refresh") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/node_modules/") ||
    pathname.startsWith("/src/") ||
    pathname.includes("/demo/") ||
    /\.[cm]?[tj]sx?$/.test(pathname) ||
    pathname.endsWith(".css") ||
    isStaticAssetPath(pathname)
  );
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.(?:avif|gif|ico|jpe?g|json|png|svg|txt|webp|woff2?)$/i.test(pathname);
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

function injectViteProductionAssets(
  html: string,
  manifest: Record<string, ViteManifestEntry>,
  entry: ViteManifestEntry,
): string {
  const styleFiles = new Set<string>();
  const importedChunks = collectViteImportedChunks(manifest, entry);

  for (const file of entry.css ?? []) {
    styleFiles.add(file);
  }

  for (const imported of importedChunks) {
    for (const file of imported.css ?? []) {
      styleFiles.add(file);
    }
  }

  const styles = [...styleFiles]
    .map((file) => `<link rel="stylesheet" href="/${file}" />`)
    .join("");
  const script = `<script type="module" src="/${entry.file}"></script>`;
  const modulepreloads = importedChunks
    .map((chunk) => `<link rel="modulepreload" href="/${chunk.file}" />`)
    .join("");
  const tags = `${styles}${script}${modulepreloads}`;

  return html.includes("</body>") ? html.replace("</body>", `${tags}</body>`) : `${html}${tags}`;
}

function collectViteImportedChunks(
  manifest: Record<string, ViteManifestEntry>,
  entry: ViteManifestEntry,
): ViteManifestEntry[] {
  const chunks: ViteManifestEntry[] = [];
  const seen = new Set<string>();

  function visit(chunk: ViteManifestEntry): void {
    for (const imported of chunk.imports ?? []) {
      if (seen.has(imported)) {
        continue;
      }

      const importedEntry = manifest[imported];

      if (!importedEntry) {
        continue;
      }

      seen.add(imported);
      visit(importedEntry);
      chunks.push(importedEntry);
    }
  }

  visit(entry);
  return chunks;
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (pathname.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (pathname.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (pathname.endsWith(".png")) {
    return "image/png";
  }

  if (pathname.endsWith(".webp")) {
    return "image/webp";
  }

  if (pathname.endsWith(".avif")) {
    return "image/avif";
  }

  if (pathname.endsWith(".ico")) {
    return "image/x-icon";
  }

  if (pathname.endsWith(".woff")) {
    return "font/woff";
  }

  if (pathname.endsWith(".woff2")) {
    return "font/woff2";
  }

  if (pathname.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (pathname.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }

  return "application/octet-stream";
}

async function serveViteProductionAsset(
  clientOutDir: string,
  request: Request,
): Promise<Response | null> {
  return serveViteFile(clientOutDir, request, { denyViteMetadata: true });
}

async function serveViteFile(
  root: string,
  request: Request,
  options?: { denyViteMetadata?: boolean },
): Promise<Response | null> {
  const url = new URL(request.url);
  let pathname: string;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (pathname.includes("\0") || (options?.denyViteMetadata && pathname.startsWith("/.vite/"))) {
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

async function isPublicAssetRequest(publicDir: string, pathname: string): Promise<boolean> {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  if (decoded.includes("\0")) {
    return false;
  }

  const assetPath = resolve(publicDir, `.${decoded}`);
  const routeToAsset = relative(publicDir, assetPath);

  if (routeToAsset.startsWith("..") || isAbsolute(routeToAsset)) {
    return false;
  }

  return Boolean((await stat(assetPath).catch(() => null))?.isFile());
}

function nodeRequestToRequest(request: IncomingMessage): Request {
  return new Request(
    request.url ? new URL(request.url, requestUrlOrigin(request)) : requestUrlOrigin(request),
    {
      headers: nodeHeaders(request),
      method: request.method,
    },
  );
}

function nodeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return headers;
}

function requestUrlOrigin(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  return `http://${host}`;
}

async function sendNodeResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;

  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  if (!webResponse.body) {
    response.end();
    return;
  }

  response.end(Buffer.from(new Uint8Array(await webResponse.arrayBuffer())));
}

function serveViteMiddleware(
  middleware: Connect.Server,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    middleware(request, response, (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(response.writableEnded);
    });
  });
}

function listen(
  server: ReturnType<typeof createHttpServer>,
  port: number,
  hostname: string | undefined,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, hostname);
  });
}

function rawSocketPayload(payload: RawData): string {
  if (Array.isArray(payload)) {
    return Buffer.concat(payload).toString("utf8");
  }

  return Buffer.from(new Uint8Array(payload)).toString("utf8");
}

async function writeProductionServerEntrypoint(
  _outDir: string,
  _metadata: StupidFpViteMetadata,
): Promise<void> {
  return undefined;
}

class SocketDelivery<TProjection, TTrace> {
  readonly #viewSockets = new Map<string, Set<WebSocket>>();
  readonly #socketView = new WeakMap<WebSocket, string>();

  send(current: WebSocket, envelopes: ServerEnvelope<TProjection, TTrace>[]): void {
    for (const envelope of envelopes) {
      const target = "viewId" in envelope ? envelope.viewId : undefined;

      if (envelope.type === "connected") {
        this.attach(current, envelope.viewId);
      }

      if (!target) {
        current.send(JSON.stringify(envelope));
        continue;
      }

      const sockets = this.#viewSockets.get(target);

      if (!sockets) {
        continue;
      }

      for (const socket of sockets) {
        socket.send(JSON.stringify(envelope));
      }
    }
  }

  close(socket: WebSocket): void {
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

  private attach(socket: WebSocket, viewId: string): void {
    this.close(socket);

    const sockets = this.#viewSockets.get(viewId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.#viewSockets.set(viewId, sockets);
    this.#socketView.set(socket, viewId);
  }
}
