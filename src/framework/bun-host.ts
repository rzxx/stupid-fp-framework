import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export type BunStyleAsset = {
  input: string;
  route?: string;
  output?: string;
  watch?: string[];
  build?: (asset: { input: string; output: string; route: string }) => void | Promise<void>;
};

export type BunClientPipeline =
  | {
      kind?: "bun";
    }
  | {
      kind: "vite";
      root?: string;
      outdir?: string;
      dev?: {
        port?: number;
      };
      reactCompiler?: boolean;
    };

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
  client?: BunClientPipeline;
  assets?: {
    styles?: BunStyleAsset[];
  };
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
  const devState: BunDevState = { lastBuildError: null };
  const delivery = new SocketDelivery<TProjection, TTrace>();
  const reload = new DevReloadDelivery();

  const client = await prepareClient(options, outdir, devState);
  const assets = await prepareAssets(options, outdir, devState);
  const watchers = options.dev?.watch
    ? watchDevInputs(options, outdir, assets, client, reload, devState)
    : [];

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

      if (url.pathname === "/__stupid_fp_dev_status" && options.dev?.watch) {
        return Response.json({
          ok: devState.lastBuildError === null,
          error: devState.lastBuildError,
        });
      }

      if (url.pathname === "/client.js") {
        return client.serveClientJs();
      }

      const clientResponse = await client.serve(request);

      if (clientResponse) {
        return clientResponse;
      }

      const asset = assets.byRoute.get(url.pathname);

      if (asset) {
        return new Response(Bun.file(asset.output), {
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
            await client.transformHtml(
              request,
              injectDevReload(injectInitialRender(shell, rendered, bootstrap), options),
            ),
            {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }
      }

      const shell = await Bun.file(options.shellPath).text();
      return new Response(await client.transformHtml(request, injectDevReload(shell, options)), {
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

    void client.close();
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
socket.addEventListener("message", (event) => {
  if (event.data === "reload") {
    location.reload();
    return;
  }

  try {
    const message = JSON.parse(event.data);
    if (message.type === "build-error") {
      console.error("[stupid-fp] dev build failed", message.error);
    }
  } catch {
    console.error("[stupid-fp] unknown dev reload message", event.data);
  }
});
</script>`;

  return html.includes("</body>")
    ? html.replace("</body>", `${script}</body>`)
    : `${html}${script}`;
}

function watchDevInputs<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
  assets: PreparedAssets,
  client: PreparedClient,
  reload: DevReloadDelivery,
  devState: BunDevState,
): FSWatcher[] {
  let pending: unknown = null;
  const watched = new Set([
    ...(options.client?.kind === "vite" ? [] : [dirname(options.clientEntry)]),
    ...assets.styles.flatMap((asset) => asset.watchPaths),
  ]);
  const rebuild = () => {
    if (pending !== null) {
      clearTimeout(pending as ReturnType<typeof setTimeout>);
    }

    pending = setTimeout(() => {
      pending = null;
      void rebuildDevOutputs(options, outdir, assets, client, reload, devState);
    }, 40);
  };

  return [...watched].map((path) => watch(path, { recursive: true }, rebuild));
}

async function rebuildDevOutputs<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
  assets: PreparedAssets,
  client: PreparedClient,
  reload: DevReloadDelivery,
  devState: BunDevState,
): Promise<void> {
  try {
    await client.rebuild();
    await buildStyleAssets(assets.styles);
    devState.lastBuildError = null;
    reload.reload();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dev build failed";
    devState.lastBuildError = message;
    reload.error(message);
  }
}

async function prepareClient<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
  devState: BunDevState,
): Promise<PreparedClient> {
  if (options.client?.kind === "vite") {
    return prepareViteClient(options, outdir, devState, options.client);
  }

  const clientOut = join(outdir, "app.js");
  await buildClient(options.clientEntry, outdir);

  return {
    async transformHtml(_request, html) {
      return html;
    },
    async serve(_request) {
      return null;
    },
    serveClientJs() {
      return new Response(Bun.file(clientOut), {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    },
    async rebuild() {
      await buildClient(options.clientEntry, outdir);
    },
    async close() {
      return undefined;
    },
  };
}

async function prepareAssets<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
  devState: BunDevState,
): Promise<PreparedAssets> {
  const styles = normalizeStyleAssets(options, outdir);
  const prepared = {
    styles,
    byRoute: new Map(styles.map((asset) => [asset.route, asset])),
  };

  try {
    await buildStyleAssets(styles);
    devState.lastBuildError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Asset build failed";
    devState.lastBuildError = message;
    throw error;
  }

  return prepared;
}

function normalizeStyleAssets<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
): PreparedStyleAsset[] {
  const styles = options.assets?.styles ?? [];

  return styles.map((asset) => {
    const route = asset.route ?? `/${asset.output ?? "styles.css"}`;
    const output = asset.output
      ? asset.output.startsWith(outdir)
        ? asset.output
        : join(outdir, asset.output)
      : join(outdir, route.replace(/^\//, ""));

    return {
      input: asset.input,
      route,
      output,
      build: asset.build,
      watchPaths: watchPathsForAsset(asset),
    };
  });
}

async function buildStyleAssets(assets: PreparedStyleAsset[]): Promise<void> {
  for (const asset of assets) {
    await mkdir(dirname(asset.output), { recursive: true });

    if (asset.build) {
      await asset.build({ input: asset.input, output: asset.output, route: asset.route });
      continue;
    }

    await Bun.write(asset.output, Bun.file(asset.input));
  }
}

function watchPathsForAsset(asset: BunStyleAsset): string[] {
  const paths = asset.watch ?? [asset.input];
  return paths.map(watchRootForPath);
}

function watchRootForPath(path: string): string {
  const globIndex = path.search(/[*{]/);
  const stablePath = globIndex === -1 ? path : path.slice(0, globIndex);
  const root =
    stablePath.endsWith("/") || stablePath.endsWith("\\") ? stablePath : dirname(stablePath);
  return root === "." ? "." : root;
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

function isViteTransformPath(pathname: string): boolean {
  return /\.[cm]?[tj]sx?$/i.test(pathname);
}

function replaceClientScript(html: string, entry: string): string {
  return html.replace(
    /<script type="module" src="\/client\.js"><\/script>/,
    `<script type="module" src="${entry}"></script>`,
  );
}

function prefixViteDevAssets(html: string, origin: string): string {
  return html.replaceAll(
    /(src|href)="\/(@vite|@react-refresh|@id|@fs|node_modules|src|demo|client)/g,
    `$1="${origin}/$2`,
  );
}

function removeClientScript(html: string): string {
  return html.replace(/<script type="module" src="\/client\.js"><\/script>/, "");
}

function injectViteProductionAssets(html: string, entry: ViteManifestEntry): string {
  const styles = (entry.css ?? [])
    .map((file) => `<link rel="stylesheet" href="/${file}" />`)
    .join("");
  const script = `<script type="module" src="/${entry.file}"></script>`;
  const tags = `${styles}${script}`;

  return html.includes("</body>") ? html.replace("</body>", `${tags}</body>`) : `${html}${tags}`;
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

  if (pathname.endsWith(".ico")) {
    return "image/x-icon";
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
  clientOutdir: string,
  request: Request,
): Promise<Response | null> {
  return serveViteFile(clientOutdir, request, { denyViteMetadata: true });
}

async function serveVitePublicAsset(root: string, request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (!isStaticAssetPath(url.pathname)) {
    return null;
  }

  return serveViteFile(join(root, "public"), request);
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

  error(error: string): void {
    for (const socket of this.#sockets) {
      socket.send(JSON.stringify({ type: "build-error", error }));
    }
  }
}

type BunDevState = {
  lastBuildError: string | null;
};

type PreparedAssets = {
  styles: PreparedStyleAsset[];
  byRoute: Map<string, PreparedStyleAsset>;
};

type PreparedClient = {
  transformHtml: (request: Request, html: string) => Promise<string>;
  serve: (request: Request) => Promise<Response | null>;
  serveClientJs: () => Response | Promise<Response>;
  rebuild: () => Promise<void>;
  close: () => Promise<void>;
};

type PreparedStyleAsset = {
  input: string;
  route: string;
  output: string;
  watchPaths: string[];
  build?: BunStyleAsset["build"];
};

async function prepareViteClient<TInput, TProjection, TTrace>(
  options: BunProgramHostOptions<TInput, TProjection, TTrace>,
  outdir: string,
  devState: BunDevState,
  client: Extract<BunClientPipeline, { kind: "vite" }>,
): Promise<PreparedClient> {
  const vite = await import("vite");
  const { default: react, reactCompilerPreset } = await import("@vitejs/plugin-react");
  const { default: babel } = await import("@rolldown/plugin-babel");
  const root = client.root ?? options.rootDir;
  const entry = viteEntryRoute(root, options.clientEntry);
  const clientOutdir = client.outdir ?? join(outdir, "client");
  const plugins = client.reactCompiler
    ? [react(), babel({ presets: [reactCompilerPreset()] })]
    : [react()];

  if (options.dev?.watch) {
    const server = await vite.createServer({
      root,
      appType: "custom",
      clearScreen: false,
      logLevel: "error",
      plugins,
      server: {
        hmr: true,
        port: client.dev?.port,
        strictPort: false,
      },
    });
    await server.listen();
    const urls = server.resolvedUrls;
    const origin = urls?.local[0]?.replace(/\/$/, "") ?? `http://localhost:5173`;

    return {
      async transformHtml(request, html) {
        const withEntry = replaceClientScript(html, entry);
        const transformed = await server.transformIndexHtml(
          new URL(request.url).pathname,
          withEntry,
        );
        return prefixViteDevAssets(transformed, origin);
      },
      async serve(request) {
        const url = new URL(request.url);
        const publicAsset = await serveVitePublicAsset(root, request);

        if (publicAsset) {
          return publicAsset;
        }

        if (isViteTransformPath(url.pathname)) {
          const transformed = await server.transformRequest(`${url.pathname}${url.search}`);

          if (transformed) {
            return new Response(transformed.code, {
              headers: { "Content-Type": "text/javascript; charset=utf-8" },
            });
          }
        }

        return proxyViteAsset(origin, request);
      },
      serveClientJs() {
        return Response.redirect(`${origin}${entry}`, 302);
      },
      async rebuild() {
        devState.lastBuildError = null;
      },
      async close() {
        await server.close();
      },
    };
  }

  await vite.build({
    root,
    appType: "custom",
    plugins,
    build: {
      outDir: clientOutdir,
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        input: options.clientEntry,
      },
    },
  });
  const manifest = (await Bun.file(join(clientOutdir, ".vite", "manifest.json")).json()) as Record<
    string,
    ViteManifestEntry
  >;
  const manifestEntry = manifest[relative(root, options.clientEntry).replaceAll(sep, "/")];

  if (!manifestEntry) {
    throw new Error("Vite client build did not produce a manifest entry");
  }

  return {
    async transformHtml(_request, html) {
      return injectViteProductionAssets(removeClientScript(html), manifestEntry);
    },
    async serve(request) {
      return serveViteProductionAsset(clientOutdir, request);
    },
    serveClientJs() {
      return Response.redirect(`/${manifestEntry.file}`, 302);
    },
    async rebuild() {
      return undefined;
    },
    async close() {
      return undefined;
    },
  };
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
