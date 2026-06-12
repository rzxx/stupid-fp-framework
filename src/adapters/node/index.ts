import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  parseClientEnvelope,
  type ClientEnvelope,
  type ConnectedEnvelope,
  type ProgramStreamBootstrap,
  type ProjectionEnvelope,
  type ServerEnvelope,
  type TraceEnvelope,
} from "../../framework/stream";

export type ProgramRuntime<TInput, TProjection, TTrace> = {
  connect: (
    envelope: Extract<ClientEnvelope<TInput>, { type: "connect" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
  receive: (
    envelope: Extract<ClientEnvelope<TInput>, { type: "input" }>,
  ) => Promise<{ envelopes: ServerEnvelope<TProjection, TTrace>[] }>;
};

export type ProgramRoute = {
  route: string;
  params: Record<string, string>;
};

export type ProgramHost<TInput, TProjection, TTrace> = {
  runtime: ProgramRuntime<TInput, TProjection, TTrace>;
  resolve?: (request: Request) => ProgramRoute | undefined | Promise<ProgramRoute | undefined>;
  render?: (
    bootstrap: ProgramStreamBootstrap<TProjection, TTrace>,
    context: ProgramRenderContext,
  ) => string | Promise<string>;
};

export type ProgramRenderContext = {
  request: Request;
};

export type ProgramServerContext = {
  mode: "development" | "production";
  env: Record<string, string | undefined>;
  platform: "node";
};

export type ProgramServerEntry<TInput, TProjection, TTrace> = {
  createProgramHost: (
    context: ProgramServerContext,
  ) => ProgramHost<TInput, TProjection, TTrace> | Promise<ProgramHost<TInput, TProjection, TTrace>>;
};

export type ProgramServer = {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
};

export type NodeProgramServerOptions<TInput, TProjection, TTrace> = {
  entry:
    | ProgramServerEntry<TInput, TProjection, TTrace>
    | (() =>
        | ProgramServerEntry<TInput, TProjection, TTrace>
        | Promise<ProgramServerEntry<TInput, TProjection, TTrace>>);
  mode?: "development" | "production";
  clientOutDir: string | URL;
  templatePath: string | URL;
  manifestPath: string | URL;
  env?: Record<string, string | undefined>;
};

export type NodeProgramListenOptions = {
  hostname?: string;
  port?: number;
};

type ViteManifestEntry = {
  file: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
};

export function createNodeProgramHandler<TInput, TProjection, TTrace>(
  options: NodeProgramServerOptions<TInput, TProjection, TTrace>,
): (request: Request) => Promise<Response> {
  let assetsPromise: Promise<ProductionAssets> | null = null;
  let hostPromise: Promise<ProgramHost<TInput, TProjection, TTrace>> | null = null;

  return async function handleNodeProgramRequest(request) {
    const url = new URL(request.url);

    if (hasUnsafePathSegment(url.pathname)) {
      return new Response("Bad request", { status: 400 });
    }

    if (url.pathname.startsWith("/.vite/")) {
      return new Response("Not found", { status: 404 });
    }

    const assets = await loadAssets();
    const asset = await serveFile(assets.clientOutDir, request, { denyViteMetadata: true });

    if (asset) {
      return asset;
    }

    const host = await loadHost();
    const route = await host.resolve?.(request);
    const template = await readFile(assets.templatePath, "utf8");

    if (route && host.render) {
      const result = await host.runtime.connect({
        type: "connect",
        route: route.route,
        params: route.params,
      });
      const bootstrap = bootstrapFromEnvelopes(result.envelopes);
      const rendered = await host.render(bootstrap, { request });

      return htmlResponse(
        injectProductionAssets(injectInitialRender(template, rendered, bootstrap), assets),
      );
    }

    return htmlResponse(injectProductionAssets(template, assets));
  };

  async function loadAssets(): Promise<ProductionAssets> {
    assetsPromise ??= readProductionAssets(options);
    return assetsPromise;
  }

  async function loadHost(): Promise<ProgramHost<TInput, TProjection, TTrace>> {
    hostPromise ??= Promise.resolve(
      typeof options.entry === "function" ? options.entry() : options.entry,
    ).then((entry) =>
      createProgramHostFromEntry(entry, {
        mode: options.mode ?? "production",
        env: options.env ?? process.env,
        platform: "node",
      }),
    );
    return hostPromise;
  }
}

export async function startNodeProgramServer<TInput, TProjection, TTrace>(
  options: NodeProgramServerOptions<TInput, TProjection, TTrace> & NodeProgramListenOptions,
): Promise<ProgramServer> {
  const handler = createNodeProgramHandler(options);
  const delivery = new SocketDelivery<TProjection, TTrace>();
  const socketServer = new WebSocketServer({ noServer: true });
  let hostPromise: Promise<ProgramHost<TInput, TProjection, TTrace>> | null = null;
  const httpServer = createHttpServer(async (nodeRequest, nodeResponse) => {
    try {
      const request = nodeRequestToRequest(nodeRequest);
      const url = new URL(request.url);

      if (url.pathname === "/stream") {
        await sendNodeResponse(
          nodeResponse,
          new Response("WebSocket upgrade required", { status: 400 }),
        );
        return;
      }

      await sendNodeResponse(nodeResponse, await handler(request));
    } catch (error) {
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
      const host = await loadHost();
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

  await listen(httpServer, options.port ?? 3000, options.hostname);

  return {
    get port() {
      const address = httpServer.address();

      if (!address || typeof address === "string") {
        throw new Error("Expected Node program server to bind a TCP port");
      }

      return address.port;
    },
    stop(closeActiveConnections?: boolean) {
      socketServer.close();

      if (closeActiveConnections) {
        httpServer.closeAllConnections();
      }

      httpServer.close();
    },
  };

  async function loadHost(): Promise<ProgramHost<TInput, TProjection, TTrace>> {
    hostPromise ??= Promise.resolve(
      typeof options.entry === "function" ? options.entry() : options.entry,
    ).then((entry) =>
      createProgramHostFromEntry(entry, {
        mode: options.mode ?? "production",
        env: options.env ?? process.env,
        platform: "node",
      }),
    );
    return hostPromise;
  }
}

export async function createProgramHostFromEntry<TInput, TProjection, TTrace>(
  entry: Partial<ProgramServerEntry<TInput, TProjection, TTrace>>,
  context: ProgramServerContext,
): Promise<ProgramHost<TInput, TProjection, TTrace>> {
  if (typeof entry.createProgramHost !== "function") {
    throw new Error("Server entry must export createProgramHost(context)");
  }

  return entry.createProgramHost(context);
}

type ProductionAssets = {
  clientOutDir: string;
  templatePath: string;
  manifest: Record<string, ViteManifestEntry>;
  manifestEntry: ViteManifestEntry;
};

async function readProductionAssets<TInput, TProjection, TTrace>(
  options: NodeProgramServerOptions<TInput, TProjection, TTrace>,
): Promise<ProductionAssets> {
  const manifestPath = filePath(options.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    ViteManifestEntry
  >;
  const manifestEntry = resolveManifestEntry(manifest);

  if (!manifestEntry) {
    throw new Error("Vite client build did not produce a manifest entry");
  }

  return {
    clientOutDir: filePath(options.clientOutDir),
    templatePath: filePath(options.templatePath),
    manifest,
    manifestEntry,
  };
}

function resolveManifestEntry(
  manifest: Record<string, ViteManifestEntry>,
): ViteManifestEntry | null {
  const entries = Object.values(manifest).filter((entry) => entry.isEntry);

  if (entries.length === 1) {
    return entries[0] ?? null;
  }

  return null;
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

function injectProductionAssets(html: string, assets: ProductionAssets): string {
  const styleFiles = new Set<string>();
  const importedChunks = collectViteImportedChunks(assets.manifest, assets.manifestEntry);

  for (const file of assets.manifestEntry.css ?? []) {
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
  const script = `<script type="module" src="/${assets.manifestEntry.file}"></script>`;
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

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function serveFile(
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

function hasUnsafePathSegment(pathname: string): boolean {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }

  return decoded.includes("\0") || decoded.split("/").includes("..");
}

export function nodeRequestToRequest(request: IncomingMessage): Request {
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

export async function sendNodeResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
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

function filePath(path: string | URL): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

export function fileUrl(path: string): URL {
  return pathToFileURL(path);
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
