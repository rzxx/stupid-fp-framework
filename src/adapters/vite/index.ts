import { pathToFileURL } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
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
  root: string;
  template: string;
  clientEntry: string;
  serverEntry: string;
  outDir?: string;
  port?: number;
  mode?: "development" | "production";
  reactCompiler?: boolean;
  dev?: {
    port?: number;
  };
};

export type ProgramServer = {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
};

export function stupidFpVite(_options: { serverEntry?: string } = {}): Plugin {
  return {
    name: "stupid-fp-vite",
  };
}

export async function buildViteProgram(options: ViteProgramOptions): Promise<void> {
  const vite = await import("vite");
  const plugins = await vitePlugins(options);
  const outDir = options.outDir ?? join(options.root, "..", "dist");
  const clientOutDir = join(outDir, "client");
  const serverOutDir = join(outDir, "server");

  await vite.build({
    root: options.root,
    appType: "custom",
    plugins,
    build: {
      outDir: clientOutDir,
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        input: options.clientEntry,
      },
    },
  });

  await vite.build({
    root: options.root,
    appType: "custom",
    plugins,
    build: {
      outDir: serverOutDir,
      emptyOutDir: true,
      ssr: options.serverEntry,
      rollupOptions: {
        output: {
          entryFileNames: "entry-server.js",
        },
      },
    },
  });
}

export async function serveViteProgram<TInput, TProjection, TTrace>(
  options: ViteProgramOptions,
): Promise<ProgramServer> {
  const mode = options.mode ?? "development";
  const outDir = options.outDir ?? join(options.root, "..", "dist");
  const delivery = new SocketDelivery<TProjection, TTrace>();
  const program = await prepareProgram<TInput, TProjection, TTrace>(options, outDir, mode);

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

async function prepareProgram<TInput, TProjection, TTrace>(
  options: ViteProgramOptions,
  outDir: string,
  mode: "development" | "production",
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  return mode === "production"
    ? prepareProductionProgram(options, outDir)
    : prepareDevelopmentProgram(options);
}

async function prepareDevelopmentProgram<TInput, TProjection, TTrace>(
  options: ViteProgramOptions,
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  const vite = await import("vite");
  const plugins = await vitePlugins(options);
  const server = await vite.createServer({
    root: options.root,
    appType: "custom",
    clearScreen: false,
    logLevel: "error",
    plugins,
    server: {
      hmr: true,
      port: options.dev?.port,
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

  const runner = vite.createServerModuleRunner(server.environments.ssr);
  const origin = localOrigin(server);
  const publicDir = server.config.publicDir;
  const clientEntry = viteEntryRoute(options.root, options.clientEntry);
  const serverEntry = viteEntryRoute(options.root, options.serverEntry);
  let cachedHost: ViteProgramHost<TInput, TProjection, TTrace> | null = null;

  server.watcher.on("change", () => {
    cachedHost = null;
    runner.clearCache();
    server.ws.send({ type: "full-reload" });
  });

  return {
    async loadHost() {
      if (cachedHost) {
        return cachedHost;
      }

      const mod =
        await runner.import<ViteProgramServerEntry<TInput, TProjection, TTrace>>(serverEntry);
      cachedHost = await mod.createProgramHost({ mode: "development" });
      return cachedHost;
    },
    async loadTemplate() {
      return injectClientEntry(await Bun.file(options.template).text(), clientEntry);
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
}

async function prepareProductionProgram<TInput, TProjection, TTrace>(
  options: ViteProgramOptions,
  outDir: string,
): Promise<PreparedProgram<TInput, TProjection, TTrace>> {
  const clientOutDir = join(outDir, "client");
  const serverEntry = join(outDir, "server", "entry-server.js");
  const manifestPath = join(clientOutDir, ".vite", "manifest.json");
  const manifest = (await Bun.file(manifestPath).json()) as Record<string, ViteManifestEntry>;
  const manifestEntry = manifest[relative(options.root, options.clientEntry).replaceAll(sep, "/")];

  if (!manifestEntry) {
    throw new Error("Vite client build did not produce a manifest entry");
  }

  return {
    async loadHost() {
      const mod = (await import(pathToFileURL(serverEntry).href)) as ViteProgramServerEntry<
        TInput,
        TProjection,
        TTrace
      >;
      return mod.createProgramHost({ mode: "production" });
    },
    async loadTemplate() {
      return Bun.file(options.template).text();
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
}

async function vitePlugins(options: ViteProgramOptions): Promise<Plugin[]> {
  const { default: react, reactCompilerPreset } = await import("@vitejs/plugin-react");
  const { default: babel } = await import("@rolldown/plugin-babel");
  const plugins: Plugin[] = [stupidFpVite()];

  plugins.push(...react());

  if (options.reactCompiler) {
    plugins.push((await babel({ presets: [reactCompilerPreset()] })) as Plugin);
  }

  return plugins;
}

function injectClientEntry(html: string, entry: string): string {
  if (html.includes(entry)) {
    return html;
  }

  const script = `<script type="module" src="${entry}"></script>`;
  return html.includes("</body>")
    ? html.replace("</body>", `${script}</body>`)
    : `${html}${script}`;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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
};

function viteEntryRoute(root: string, entrypoint: string): string {
  const absolute = isAbsolute(entrypoint) ? entrypoint : join(root, entrypoint);
  return `/${relative(root, absolute).replaceAll(sep, "/")}`;
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
