import { describe, expect, test } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBuilder, createServer, type ViteDevServer } from "vite";
import WebSocket from "ws";
import type { ClientEnvelope, ServerEnvelope } from "../src/framework";

const testDir = dirname(fileURLToPath(import.meta.url));

type TestMessage = { type: "action.touch" };
type TestProjection = { viewId: string; value: number };
type TestTrace = { traceId: string; events: unknown[] };
type QueuedSocket = WebSocket & {
  pendingEnvelopes: ServerEnvelope<TestProjection, TestTrace>[];
  envelopeWaiters: ((envelope: ServerEnvelope<TestProjection, TestTrace>) => boolean)[];
};
type RunningProgramServer = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
};
type HtmlBootstrap = {
  viewId: string;
  projectionVersion: number;
  projection: TestProjection;
};

describe("Vite-native program host", () => {
  test("delivers returned stream envelopes to every connected view they target", async () => {
    const root = await createHostFixture();
    const server = await startViteDevServer(root);
    const first = await openSocket(server.port);
    const second = await openSocket(server.port);

    try {
      first.send(
        JSON.stringify({
          type: "connect",
          route: "/test",
          params: { id: "first" },
        } satisfies ClientEnvelope<TestMessage>),
      );
      second.send(
        JSON.stringify({
          type: "connect",
          route: "/test",
          params: { id: "second" },
        } satisfies ClientEnvelope<TestMessage>),
      );

      expect(await readEnvelope(first, "connected")).toMatchObject({
        viewId: "view-first",
      });
      expect(await readEnvelope(second, "connected")).toMatchObject({
        viewId: "view-second",
      });
      await readEnvelope(first, "projection:update");
      await readEnvelope(second, "projection:update");

      first.send(
        JSON.stringify({
          type: "input",
          viewId: "view-first",
          input: { type: "action.touch" },
        } satisfies ClientEnvelope<TestMessage>),
      );

      expect(await readEnvelope(first, "action:result")).toMatchObject({
        viewId: "view-first",
        ok: true,
      });
      expect(await readEnvelope(second, "projection:patch")).toMatchObject({
        viewId: "view-second",
        patch: {
          kind: "region-values",
          regions: [expect.objectContaining({ id: "shared", value: 1 })],
        },
      });
    } finally {
      first.close();
      second.close();
      await server.close();
    }
  });

  test("renders an initial HTML snapshot through Vite dev middleware", async () => {
    const root = await createHostFixture();
    const server = await startViteDevServer(root);

    try {
      const response = await fetch(`http://localhost:${server.port}/test?id=initial`);
      const html = await response.text();
      const bootstrap = parseBootstrap(html);
      const stylesheetPath = stylesheetHref(html);

      expect(response.headers.get("content-type")).toContain("text/html");
      expect(serverRenderedValue(html, "view-initial")).toBe("0");
      expect(stylesheetPath).toBe("/client.css");
      expect(html.indexOf(`href="${stylesheetPath}"`)).toBeLessThan(html.indexOf("<body"));
      expect(bootstrap).toMatchObject({
        viewId: "view-initial",
        projectionVersion: 1,
        projection: { viewId: "view-initial", value: 0 },
      });
      expect(html).toContain("/@vite/client");
      await expectStylesheetServed(server.port, stylesheetPath, "host-test-css");
      await expectHtmlLoadsClientEntry(server.port, html);
    } finally {
      await server.close();
    }
  });

  test("serves Vite dev modules and public assets", async () => {
    const root = await createHostFixture();
    await mkdir(join(root, "public", ".well-known"), { recursive: true });
    await writeFile(join(root, "public", "favicon.svg"), "<svg>dev</svg>\n");
    await writeFile(join(root, "public", ".well-known", "security"), "contact=dev\n");

    const server = await startViteDevServer(root);

    try {
      const htmlResponse = await fetch(`http://localhost:${server.port}/test`);
      const html = await htmlResponse.text();
      const clientResponse = await fetch(`http://localhost:${server.port}/client.ts`);
      const stylesheetPath = stylesheetHref(html);
      const faviconResponse = await fetch(`http://localhost:${server.port}/favicon.svg`);
      const wellKnownResponse = await fetch(`http://localhost:${server.port}/.well-known/security`);
      const traversalResponse = await fetch(`http://localhost:${server.port}/%2e%2e%2ffavicon.svg`);

      expect(html).toContain("/@vite/client");
      expect(stylesheetPath).toBe("/client.css");
      await expectHtmlLoadsClientEntry(server.port, html);
      expect(await clientResponse.text()).toContain("vite host test");
      expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
      expect(await faviconResponse.text()).toContain("<svg>dev</svg>");
      expect(await wellKnownResponse.text()).toContain("contact=dev");
      expect(traversalResponse.status).not.toBe(200);
    } finally {
      await server.close();
    }
  });

  test("supports Tailwind through the normal Vite CSS plugin pipeline", async () => {
    const root = await createHostFixture({
      clientSource: 'import "./client.css";\nconsole.log("vite host test bg-red-500");\n',
      configSource: (fixtureRoot) => viteConfigSource(fixtureRoot, { tailwind: true }),
      linkedNodeModules: ["tailwindcss"],
      stylesheetSource: '@import "tailwindcss";\n',
    });
    const server = await startViteDevServer(root);

    try {
      const htmlResponse = await fetch(`http://localhost:${server.port}/test`);
      const html = await htmlResponse.text();
      const stylesheetPath = stylesheetHref(html);
      const stylesheetResponse = await fetch(`http://localhost:${server.port}${stylesheetPath}`, {
        headers: { accept: "text/css" },
      });
      const stylesheet = await stylesheetResponse.text();

      expect(stylesheetPath).toBe("/client.css");
      expect(stylesheetResponse.headers.get("content-type")).toContain("text/css");
      expect(stylesheet).toContain(".bg-red-500");
    } finally {
      await server.close();
    }
  });

  test("builds a runnable Node production server entry", async () => {
    const root = await createHostFixture({
      configSource: (fixtureRoot) => viteConfigSource(fixtureRoot, { htmlTransform: true }),
    });
    await mkdir(join(root, "public", ".well-known"), { recursive: true });
    await writeFile(join(root, "public", "favicon.svg"), "<svg>production</svg>\n");
    await writeFile(join(root, "public", ".well-known", "security"), "contact=production\n");
    await buildViteApp(root);

    const server = await startBuiltServer(root);

    try {
      const htmlResponse = await fetch(`http://localhost:${server.port}/test`);
      const html = await htmlResponse.text();
      const scriptPath = html.match(/<script type="module" src="([^"]+)"/)?.[1];
      const stylesheetPath = stylesheetHref(html);

      if (!scriptPath) {
        throw new Error("Expected production HTML to include a Vite script");
      }

      const scriptResponse = await fetch(`http://localhost:${server.port}${scriptPath}`);
      const stylesheetResponse = await fetch(`http://localhost:${server.port}${stylesheetPath}`, {
        headers: { accept: "text/css" },
      });
      const faviconResponse = await fetch(`http://localhost:${server.port}/favicon.svg`);
      const wellKnownResponse = await fetch(`http://localhost:${server.port}/.well-known/security`);
      const manifestResponse = await fetch(`http://localhost:${server.port}/.vite/manifest.json`);
      const traversalResponse = await fetch(`http://localhost:${server.port}/%2e%2e%2ffavicon.svg`);
      const bootstrap = parseBootstrap(html);

      expect(scriptPath).toMatch(/^\/assets\//);
      expect(stylesheetPath).toMatch(/^\/assets\//);
      expect(html.indexOf(`href="${stylesheetPath}"`)).toBeLessThan(html.indexOf('<div id="root"'));
      expect(stylesheetResponse.headers.get("content-type")).toContain("text/css");
      expect(await stylesheetResponse.text()).toContain("host-test-css");
      expect(html).toContain('data-transformed="true"');
      expect(bootstrap).toMatchObject({
        viewId: "view-initial",
        projection: { viewId: "view-initial", value: 0 },
      });
      expect(await scriptResponse.text()).toContain("vite host test");
      expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
      expect(await faviconResponse.text()).toContain("<svg>production</svg>");
      expect(wellKnownResponse.status).toBe(200);
      expect(await wellKnownResponse.text()).toContain("contact=production");
      expect(manifestResponse.status).not.toBe(200);
      expect(traversalResponse.status).not.toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("reuses the production host across HTTP requests", async () => {
    const root = await createHostFixture({
      serverSource: statefulServerEntrySource(),
    });
    await buildViteApp(root);

    const server = await startBuiltServer(root);

    try {
      const first = await fetch(`http://localhost:${server.port}/test?id=stateful`);
      const second = await fetch(`http://localhost:${server.port}/test?id=stateful`);

      expect(serverRenderedValue(await first.text(), "view-stateful")).toBe("1");
      expect(serverRenderedValue(await second.text(), "view-stateful")).toBe("2");
    } finally {
      server.stop(true);
    }
  });

  test("runs the generated Node server when executed directly", async () => {
    const root = await createHostFixture();
    await buildViteApp(root);

    const server = await startAutostartedBuiltServer(root);

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/test?id=autostart`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(parseBootstrap(html)).toMatchObject({
        viewId: "view-autostart",
        projection: { value: 0 },
      });
    } finally {
      server.stop();
    }
  });

  test("reports a clear error when the server entry is missing createProgramHost", async () => {
    const root = await createHostFixture({
      serverSource: "export const notAProgramHost = true;\n",
    });
    await buildViteApp(root);

    const server = await startBuiltServer(root);

    try {
      const response = await fetch(`http://localhost:${server.port}/test`);

      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        "Server entry must export createProgramHost(context)",
      );
    } finally {
      server.stop(true);
    }
  });

  test("fails clearly when the Vite config registers duplicate framework plugins", async () => {
    const root = await createHostFixture({
      configSource: (fixtureRoot) => viteConfigSource(fixtureRoot, { duplicatePlugin: true }),
    });

    await expect(createServer({ configFile: join(root, "vite.config.ts") })).rejects.toThrow(
      "Vite config must include exactly one stupidFp() plugin",
    );
  });
});

type HostFixtureOptions = {
  clientSource?: string;
  linkedNodeModules?: string[];
  serverSource?: string;
  stylesheetSource?: string;
  configSource?: string | ((root: string) => string);
};

type RunningViteServer = {
  port: number;
  close: () => Promise<void>;
};

async function startViteDevServer(root: string): Promise<RunningViteServer> {
  const server = await createServer({
    configFile: join(root, "vite.config.ts"),
    server: {
      port: 0,
      strictPort: false,
    },
  });
  await server.listen();

  return {
    port: serverPort(server),
    close: () => server.close(),
  };
}

async function buildViteApp(root: string): Promise<void> {
  const builder = await createBuilder({
    configFile: join(root, "vite.config.ts"),
    mode: "production",
  });
  await builder.buildApp();
}

async function startBuiltServer(root: string): Promise<RunningProgramServer> {
  const previousAutostart = process.env.STUPID_FP_AUTOSTART;

  process.env.STUPID_FP_AUTOSTART = "false";

  try {
    const mod = (await import(
      `${pathToFileURL(join(root, "dist", "server", "index.js")).href}?t=${crypto.randomUUID()}`
    )) as {
      start: (options: { port: number }) => Promise<RunningProgramServer>;
    };

    return mod.start({ port: 0 });
  } finally {
    if (previousAutostart === undefined) {
      delete process.env.STUPID_FP_AUTOSTART;
    } else {
      process.env.STUPID_FP_AUTOSTART = previousAutostart;
    }
  }
}

async function startAutostartedBuiltServer(root: string): Promise<RunningProgramServer> {
  const { STUPID_FP_AUTOSTART: _autostart, ...env } = process.env;
  const child = spawn(process.execPath, [join(root, "dist", "server", "index.js")], {
    cwd: root,
    env: {
      ...env,
      HOST: "127.0.0.1",
      PORT: "0",
    },
  });

  const port = await waitForAutostartedPort(child);

  return {
    port,
    stop() {
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

function waitForAutostartedPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for generated server to listen\n${stderr}`));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const succeed = (port: number) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(port);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      child.kill();
      reject(error);
    };
    const onStdout = (chunk: Buffer) => {
      const match = chunk.toString("utf8").match(/http:\/\/[^:]+:(\d+)/);

      if (match?.[1]) {
        succeed(Number(match[1]));
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `Generated server exited before listening: code=${code} signal=${signal}\n${stderr}`,
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function serverPort(server: ViteDevServer): number {
  const address = server.httpServer?.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected Vite dev server to bind a TCP port");
  }

  return address.port;
}

function parseBootstrap(html: string): HtmlBootstrap {
  const match = html.match(/window\.__STUPID_FP_BOOTSTRAP__=(.*?);<\/script>/);

  if (!match?.[1]) {
    throw new Error("Expected HTML to include the framework bootstrap payload");
  }

  return JSON.parse(match[1]) as HtmlBootstrap;
}

function serverRenderedValue(html: string, viewId: string): string {
  const match = html.match(
    new RegExp(`<main\\b[^>]*data-view="${escapeRegExp(viewId)}"[^>]*>([^<]*)<\\/main>`),
  );

  if (!match?.[1]) {
    throw new Error(`Expected HTML to include a server-rendered view for ${viewId}`);
  }

  return match[1];
}

async function expectHtmlLoadsClientEntry(port: number, html: string): Promise<void> {
  const scripts = Array.from(
    html.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/g),
    (match) => match[1],
  ).filter((src) => src && !src.includes("/@vite/client"));

  expect(scripts.length).toBeGreaterThan(0);

  const modules = await Promise.all(
    scripts.map(async (src) => {
      const response = await fetch(localUrl(port, src));

      expect(response.status).toBe(200);
      return response.text();
    }),
  );

  expect(
    modules.some((source) => source.includes("vite host test") || source.includes("/client.ts")),
  ).toBe(true);
}

async function expectStylesheetServed(
  port: number,
  path: string,
  expectedSource: string,
): Promise<void> {
  const response = await fetch(localUrl(port, path), { headers: { accept: "text/css" } });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/css");
  expect(await response.text()).toContain(expectedSource);
}

function stylesheetHref(html: string): string {
  const stylesheetPath = html.match(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/)?.[1];

  if (!stylesheetPath) {
    throw new Error("Expected HTML to include a stylesheet link");
  }

  return stylesheetPath;
}

function localUrl(port: number, path: string): string {
  return new URL(path, `http://localhost:${port}`).href;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createHostFixture(options: HostFixtureOptions = {}): Promise<string> {
  const root = join(tmpdir(), `stupid-fp-vite-host-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await linkFixtureNodeModules(root, options.linkedNodeModules ?? []);
  await writeFile(
    join(root, "client.ts"),
    options.clientSource ?? 'import "./client.css";\nconsole.log("vite host test");\n',
  );
  await writeFile(
    join(root, "client.css"),
    options.stylesheetSource ?? ".host-test-css { color: #010203; }\n",
  );
  await writeFile(join(root, "index.html"), '<html><body><div id="root"></div></body></html>');
  await writeFile(join(root, "server.ts"), options.serverSource ?? serverEntrySource());
  await writeFile(
    join(root, "vite.config.ts"),
    typeof options.configSource === "function"
      ? options.configSource(root)
      : (options.configSource ?? viteConfigSource(root)),
  );
  return root;
}

async function linkFixtureNodeModules(root: string, packages: string[]): Promise<void> {
  if (packages.length === 0) {
    return;
  }

  const modulesRoot = join(root, "node_modules");
  await mkdir(modulesRoot, { recursive: true });

  for (const packageName of packages) {
    const target = join(testDir, "..", "node_modules", packageName);
    const link = join(modulesRoot, packageName);
    await symlink(target, link, "junction");
  }
}

function viteConfigSource(
  root: string,
  options?: { duplicatePlugin?: boolean; htmlTransform?: boolean; tailwind?: boolean },
): string {
  const tailwindImport = options?.tailwind
    ? `import tailwindcss from ${JSON.stringify(
        relativeImport(root, "node_modules/@tailwindcss/vite/dist/index.mjs"),
      )};`
    : "";
  const tailwindPlugin = options?.tailwind ? "tailwindcss()" : "";
  const plugin = `
    stupidFp({
      template: "index.html",
      client: "client.ts",
      server: "server.ts",
    })`;
  const htmlTransformPlugin = `
    {
      name: "test-html-transform",
      transformIndexHtml(html) {
        return html.replace("<body>", '<body data-transformed="true">');
      },
    }`;
  const plugins = [
    ...(tailwindPlugin ? [tailwindPlugin] : []),
    plugin,
    ...(options?.htmlTransform ? [htmlTransformPlugin] : []),
    ...(options?.duplicatePlugin ? [plugin] : []),
  ].join(",");

  return `
import { stupidFp } from ${JSON.stringify(relativeImport(root, "src/vite.ts"))};
${tailwindImport}

export default {
  root: ${JSON.stringify(root.replaceAll("\\", "/"))},
  build: {
    outDir: ${JSON.stringify(join(root, "dist").replaceAll("\\", "/"))},
  },
  plugins: [
    ${plugins}
  ],
};
`;
}

function relativeImport(fromRoot: string, target: string): string {
  const path = relative(fromRoot, join(testDir, "..", target)).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

function serverEntrySource(): string {
  return `
export function createProgramHost() {
  return {
    runtime: createFanoutRuntime(),
    resolve(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/test") return undefined;
      return { route: "/test", params: { id: url.searchParams.get("id") ?? "initial" } };
    },
    render(bootstrap) {
      return \`<main data-view="\${bootstrap.viewId}">\${bootstrap.projection.value}</main>\`;
    },
  };
}

function createFanoutRuntime() {
  return {
    async connect(envelope) {
      const viewId = \`view-\${envelope.params.id}\`;

      return {
        envelopes: [
          {
            type: "connected",
            viewId,
            cursor: \`\${viewId}-cursor-1\`,
            resumed: false,
            resume: { status: "fresh" },
          },
          {
            type: "projection:update",
            viewId,
            cursor: \`\${viewId}-cursor-2\`,
            projectionVersion: 1,
            projection: { viewId, value: 0 },
            regions: [],
          },
        ],
      };
    },
    async receive() {
      return {
        envelopes: [
          {
            type: "action:result",
            viewId: "view-first",
            cursor: "cursor-action",
            traceId: "trace-1",
            action: "touch",
            ok: true,
          },
          {
            type: "projection:patch",
            viewId: "view-second",
            cursor: "cursor-patch",
            projectionVersion: 2,
            patch: {
              kind: "region-values",
              regions: [
                {
                  id: "shared",
                  value: 1,
                  resources: [{ type: "Shared", id: "main", label: "Shared(main)" }],
                },
              ],
            },
            causedByTraceId: "trace-1",
          },
        ],
      };
    },
  };
}
`;
}

function statefulServerEntrySource(): string {
  return `
export function createProgramHost() {
  let connects = 0;

  return {
    runtime: {
      async connect(envelope) {
        connects += 1;
        const viewId = \`view-\${envelope.params.id}\`;

        return {
          envelopes: [
            {
              type: "connected",
              viewId,
              cursor: \`\${viewId}-cursor-1\`,
              resumed: false,
              resume: { status: "fresh" },
            },
            {
              type: "projection:update",
              viewId,
              cursor: \`\${viewId}-cursor-2\`,
              projectionVersion: connects,
              projection: { viewId, value: connects },
              regions: [],
            },
          ],
        };
      },
      async receive() {
        return { envelopes: [] };
      },
    },
    resolve(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/test") return undefined;
      return { route: "/test", params: { id: url.searchParams.get("id") ?? "initial" } };
    },
    render(bootstrap) {
      return \`<main data-view="\${bootstrap.viewId}">\${bootstrap.projection.value}</main>\`;
    },
  };
}
`;
}

async function openSocket(port: number): Promise<QueuedSocket> {
  const socket = new WebSocket(`ws://localhost:${port}/stream`) as QueuedSocket;
  socket.pendingEnvelopes = [];
  socket.envelopeWaiters = [];

  socket.on("message", (data) => {
    const envelope = JSON.parse(String(data)) as ServerEnvelope<TestProjection, TestTrace>;
    const waiterIndex = socket.envelopeWaiters.findIndex((waiter) => waiter(envelope));

    if (waiterIndex >= 0) {
      socket.envelopeWaiters.splice(waiterIndex, 1);
      return;
    }

    socket.pendingEnvelopes.push(envelope);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", () => reject(new Error("WebSocket failed to open")));
  });

  return socket;
}

async function readEnvelope(
  socket: QueuedSocket,
  type: ServerEnvelope<TestProjection, TestTrace>["type"],
): Promise<ServerEnvelope<TestProjection, TestTrace>> {
  const queuedIndex = socket.pendingEnvelopes.findIndex((envelope) => envelope.type === type);

  if (queuedIndex >= 0) {
    const [envelope] = socket.pendingEnvelopes.splice(queuedIndex, 1);

    if (envelope) {
      return envelope;
    }
  }

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.envelopeWaiters = socket.envelopeWaiters.filter((waiter) => waiter !== onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 1000);

    function onMessage(envelope: ServerEnvelope<TestProjection, TestTrace>) {
      if (envelope.type !== type) {
        return false;
      }

      clearTimeout(timeout);
      resolve(envelope);
      return true;
    }

    socket.envelopeWaiters.push(onMessage);
  });
}
