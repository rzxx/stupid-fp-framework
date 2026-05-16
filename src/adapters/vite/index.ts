import { pathToFileURL } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import type { HtmlTagDescriptor, Plugin, PluginOption, ResolvedConfig, ViteDevServer } from "vite";
import {
  parseClientEnvelope,
  type ClientEnvelope,
  type ConnectedEnvelope,
  type ProgramStreamBootstrap,
  type ProjectionEnvelope,
  type ServerEnvelope,
  type TraceEnvelope,
} from "../../framework/stream";

type BunSocketData = { kind: "stream" };
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
};

export type ViteProgramOptions = {
  configFile?: string;
  port?: number;
  mode?: "development" | "production";
};

export type ProgramServer = {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
};

export type StupidFpViteOptions = {
  template: string;
  client: string;
  server: string;
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

export function stupidFpVite(options: StupidFpViteOptions): PluginOption[] {
  validatePluginOptions(options);

  const frameworkPlugin: StupidFpVitePlugin = {
    name: pluginName,
    configResolved(config) {
      frameworkPlugin[metadataKey] = resolvePluginMetadata(config, options);
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
    transformIndexHtml() {
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
  };
  const plugins: PluginOption[] = [frameworkPlugin, ...react()];

  if (options.reactCompiler) {
    plugins.push(babel({ presets: [reactCompilerPreset()] }));
  }

  return plugins;
}

export async function buildViteProgram(
  options: Omit<ViteProgramOptions, "port"> = {},
): Promise<void> {
  const previousNodeEnv = Bun.env.NODE_ENV;
  const { vite, app, config } = await resolveViteProgramConfig("build", {
    ...options,
    mode: options.mode ?? "production",
  });
  const outDir = resolvedOutDir(config);
  const clientOutDir = join(outDir, "client");
  const serverOutDir = join(outDir, "server");

  if (!previousNodeEnv) {
    Bun.env.NODE_ENV = "production";
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
        rollupOptions: {
          input: app.clientVirtualId,
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
        rollupOptions: {
          input: app.serverVirtualId,
          output: {
            entryFileNames: "entry-server.js",
          },
        },
      },
    });
  } finally {
    if (previousNodeEnv === undefined) {
      delete Bun.env.NODE_ENV;
    } else {
      Bun.env.NODE_ENV = previousNodeEnv;
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

  const server = Bun.serve<BunSocketData>({
    port: options.port,
    async fetch(request, bunServer) {
      const url = new URL(request.url);

      if (hasUnsafePathSegment(url.pathname)) {
        return new Response("Bad request", { status: 400 });
      }

      if (url.pathname.startsWith("/.vite/")) {
        return new Response("Not found", { status: 404 });
      }

      if (url.pathname === "/stream") {
        if (bunServer.upgrade(request, { data: { kind: "stream" as const } })) {
          return;
        }

        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const asset = await program.serveAsset(request);

      if (asset) {
        return asset;
      }

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
    },
    websocket: {
      async message(socket, payload) {
        const host = await program.loadHost();
        const parsed = parseClientEnvelope<TInput>(String(payload));

        if (parsed.type === "error") {
          socket.send(JSON.stringify(parsed));
          return;
        }

        const result =
          parsed.type === "connect"
            ? await host.runtime.connect(parsed)
            : await host.runtime.receive(parsed);

        delivery.send(socket, result.envelopes);
      },
      close(socket) {
        delivery.close(socket);
      },
    },
  });

  return {
    get port() {
      if (server.port === undefined) {
        throw new Error("Expected Vite program server to bind a port");
      }

      return server.port;
    },
    stop(closeActiveConnections?: boolean) {
      void program.close();
      server.stop(closeActiveConnections);
    },
  };
}

type PreparedProgram<TInput, TProjection, TTrace> = {
  loadHost: () => Promise<ViteProgramHost<TInput, TProjection, TTrace>>;
  loadTemplate: (request: Request) => Promise<string>;
  transformHtml: (request: Request, html: string) => Promise<string>;
  serveAsset: (request: Request) => Promise<Response | null>;
  close: () => Promise<void>;
};

type ResolvedViteProgramConfig = {
  vite: typeof import("vite");
  config: ResolvedConfig;
  app: StupidFpViteMetadata;
};

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
    logLevel: Bun.env.NODE_ENV === "test" ? "error" : "info",
    server: {
      hmr: true,
      strictPort: false,
    },
    environments: {
      ssr: {
        dev: {
          moduleRunnerTransform: true,
        },
      },
    },
  });
  await server.listen();
  if (Bun.env.NODE_ENV !== "test") {
    server.printUrls();
  }

  const runner = resolved.vite.createServerModuleRunner(server.environments.ssr);
  const origin = localOrigin(server);
  const publicDir = server.config.publicDir;
  let cachedHost: ViteProgramHost<TInput, TProjection, TTrace> | null = null;

  server.watcher.on("change", () => {
    cachedHost = null;
    runner.clearCache();
    server.ws.send({ type: "full-reload" });
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
      return Bun.file(resolved.app.template).text();
    },
    async transformHtml(request, html) {
      const transformed = await server.transformIndexHtml(new URL(request.url).pathname, html);
      return prefixViteDevAssets(transformed, origin);
    },
    async serveAsset(request) {
      const publicAsset = await serveVitePublicAsset(publicDir, request);

      if (publicAsset) {
        return publicAsset;
      }

      return proxyViteAsset(origin, request);
    },
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

async function prepareProductionProgram<TInput, TProjection, TTrace>(
  resolved: ResolvedViteProgramConfig,
  outDir: string,
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  const clientOutDir = join(outDir, "client");
  const serverEntry = join(outDir, "server", "entry-server.js");
  const manifestPath = join(clientOutDir, ".vite", "manifest.json");
  const manifest = (await Bun.file(manifestPath).json()) as Record<string, ViteManifestEntry>;
  const manifestEntry = resolveManifestEntry(manifest);

  if (!manifestEntry) {
    throw new Error("Vite client build did not produce a manifest entry");
  }

  const prepared: PreparedProgram<TInput, TProjection, TTrace> = {
    async loadHost() {
      const mod = (await import(pathToFileURL(serverEntry).href)) as ViteProgramServerEntry<
        TInput,
        TProjection,
        TTrace
      >;
      return createProgramHostFromModule(mod, "production");
    },
    async loadTemplate() {
      return Bun.file(resolved.app.template).text();
    },
    async transformHtml(_request, html) {
      return injectViteProductionAssets(html, manifest, manifestEntry);
    },
    async serveAsset(request) {
      return serveViteProductionAsset(clientOutDir, request);
    },
    async close() {
      return undefined;
    },
  };

  await prepared.loadHost();
  return prepared;
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

  return mod.createProgramHost({ mode });
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

function validatePluginOptions(options: StupidFpViteOptions): void {
  if (!options.template) {
    throw new Error("stupidFpVite() requires a template path");
  }

  if (!options.client) {
    throw new Error("stupidFpVite() requires a client entry path");
  }

  if (!options.server) {
    throw new Error("stupidFpVite() requires a server entry path");
  }
}

function resolvePluginMetadata(
  config: ResolvedConfig,
  options: StupidFpViteOptions,
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

function localOrigin(server: ViteDevServer): string {
  return server.resolvedUrls?.local[0]?.replace(/\/$/, "") ?? "http://localhost:5173";
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

async function proxyViteAsset(origin: string, request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (!isViteAssetPath(url.pathname)) {
    return null;
  }

  const upstream = await fetch(`${origin}${url.pathname}${url.search}`);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
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

function prefixViteDevAssets(html: string, origin: string): string {
  return html.replaceAll(
    /(src|href)="\/(@vite|@react-refresh|@id|@fs|node_modules|src|demo|client)/g,
    `$1="${origin}/$2`,
  );
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

async function serveVitePublicAsset(publicDir: string, request: Request): Promise<Response | null> {
  return serveViteFile(publicDir, request);
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

  const file = Bun.file(assetPath);

  if (!(await file.exists())) {
    return null;
  }

  return new Response(file, {
    headers: { "Content-Type": contentType(pathname) },
  });
}

class SocketDelivery<TProjection, TTrace> {
  readonly #viewsockets = new Map<string, Set<Bun.ServerWebSocket<unknown>>>();
  readonly #socketview = new WeakMap<Bun.ServerWebSocket<unknown>, string>();

  send(
    current: Bun.ServerWebSocket<unknown>,
    envelopes: ServerEnvelope<TProjection, TTrace>[],
  ): void {
    for (const envelope of envelopes) {
      const target = "viewId" in envelope ? envelope.viewId : undefined;

      if (envelope.type === "connected") {
        this.attach(current, envelope.viewId);
      }

      if (!target) {
        current.send(JSON.stringify(envelope));
        continue;
      }

      const sockets = this.#viewsockets.get(target);

      if (!sockets) {
        continue;
      }

      for (const socket of sockets) {
        socket.send(JSON.stringify(envelope));
      }
    }
  }

  close(socket: Bun.ServerWebSocket<unknown>): void {
    const viewId = this.#socketview.get(socket);

    if (!viewId) {
      return;
    }

    this.#viewsockets.get(viewId)?.delete(socket);
    this.#socketview.delete(socket);
  }

  private attach(socket: Bun.ServerWebSocket<unknown>, viewId: string): void {
    this.close(socket);

    const sockets = this.#viewsockets.get(viewId) ?? new Set<Bun.ServerWebSocket<unknown>>();
    sockets.add(socket);
    this.#viewsockets.set(viewId, sockets);
    this.#socketview.set(socket, viewId);
  }
}
