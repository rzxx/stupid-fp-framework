import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { buildViteProgram, serveViteProgram } from "../src/vite";
import type { ClientEnvelope, ServerEnvelope } from "../src/framework";

const testDir = dirname(fileURLToPath(import.meta.url));

type TestMessage = { type: "action.touch" };
type TestProjection = { viewId: string; value: number };
type TestTrace = { traceId: string; events: unknown[] };
type QueuedSocket = WebSocket & {
  pendingEnvelopes: ServerEnvelope<TestProjection, TestTrace>[];
  envelopeWaiters: ((envelope: ServerEnvelope<TestProjection, TestTrace>) => boolean)[];
};

describe("Vite host stream delivery", () => {
  test("delivers returned envelopes to every connected view they target", async () => {
    const root = await createHostFixture();
    const server = await serveViteProgram({
      configFile: join(root, "vite.config.ts"),
      port: 0,
    });

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
      server.stop(true);
    }
  });

  test("renders an initial HTML snapshot with stream bootstrap state", async () => {
    const root = await createHostFixture();
    const server = await serveViteProgram({
      configFile: join(root, "vite.config.ts"),
      port: 0,
    });

    try {
      const response = await fetch(`http://localhost:${server.port}/test?id=initial`);
      const html = await response.text();

      expect(response.headers.get("content-type")).toContain("text/html");
      expect(html).toContain('<div id="root"><main data-view="view-initial">0</main></div>');
      expect(html).toContain("window.__STUPID_FP_BOOTSTRAP__=");
      expect(html).toContain('"viewId":"view-initial"');
      expect(html).toContain('"projectionVersion":1');
      expect(html).toContain("/@vite/client");
      expect(html).toContain("/@id/virtual:stupid-fp/client");
    } finally {
      server.stop(true);
    }
  });

  test("serves Vite dev modules and public assets while Bun owns the stream runtime", async () => {
    const root = await createHostFixture();
    await mkdir(join(root, "public", ".well-known"), { recursive: true });
    await writeFile(join(root, "public", "favicon.svg"), "<svg>dev</svg>\n");
    await writeFile(join(root, "public", ".well-known", "security"), "contact=dev\n");

    const server = await serveViteProgram({
      configFile: join(root, "vite.config.ts"),
      port: 0,
    });

    try {
      const htmlResponse = await fetch(`http://localhost:${server.port}/test`);
      const html = await htmlResponse.text();
      const clientResponse = await fetch(`http://localhost:${server.port}/client.ts`);
      const faviconResponse = await fetch(`http://localhost:${server.port}/favicon.svg`);
      const wellKnownResponse = await fetch(`http://localhost:${server.port}/.well-known/security`);
      const traversalResponse = await fetch(`http://localhost:${server.port}/%2e%2e%2ffavicon.svg`);

      expect(html).toContain("/@vite/client");
      expect(html).toContain("/@id/virtual:stupid-fp/client");
      expect(await clientResponse.text()).toContain("vite host test");
      expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
      expect(await faviconResponse.text()).toContain("<svg>dev</svg>");
      expect(await wellKnownResponse.text()).toContain("contact=dev");
      expect(traversalResponse.status).not.toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("serves production manifest output and public assets after Vite build", async () => {
    const root = await createHostFixture({
      configSource: (fixtureRoot) => viteConfigSource(fixtureRoot, { htmlTransform: true }),
    });
    await mkdir(join(root, "public", ".well-known"), { recursive: true });
    await writeFile(join(root, "public", "favicon.svg"), "<svg>production</svg>\n");
    await writeFile(join(root, "public", ".well-known", "security"), "contact=production\n");
    await buildViteProgram({
      configFile: join(root, "vite.config.ts"),
      mode: "production",
    });

    const server = await serveViteProgram({
      configFile: join(root, "vite.config.ts"),
      port: 0,
      mode: "production",
    });

    try {
      const htmlResponse = await fetch(`http://localhost:${server.port}/test`);
      const html = await htmlResponse.text();
      const scriptPath = html.match(/<script type="module" src="([^"]+)"/)?.[1];

      if (!scriptPath) {
        throw new Error("Expected production HTML to include a Vite script");
      }

      const scriptResponse = await fetch(`http://localhost:${server.port}${scriptPath}`);
      const faviconResponse = await fetch(`http://localhost:${server.port}/favicon.svg`);
      const wellKnownResponse = await fetch(`http://localhost:${server.port}/.well-known/security`);
      const manifestResponse = await fetch(`http://localhost:${server.port}/.vite/manifest.json`);
      const traversalResponse = await fetch(`http://localhost:${server.port}/%2e%2e%2ffavicon.svg`);

      expect(scriptPath).toMatch(/^\/assets\//);
      expect(html).toContain('data-transformed="true"');
      expect(html).not.toContain("/@id/virtual:stupid-fp/client");
      expect(await scriptResponse.text()).toContain("vite host test");
      expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
      expect(await faviconResponse.text()).toContain("<svg>production</svg>");
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
    await buildViteProgram({
      configFile: join(root, "vite.config.ts"),
      mode: "production",
    });

    const server = await serveViteProgram({
      configFile: join(root, "vite.config.ts"),
      port: 0,
      mode: "production",
    });

    try {
      const first = await fetch(`http://localhost:${server.port}/test?id=stateful`);
      const second = await fetch(`http://localhost:${server.port}/test?id=stateful`);

      expect(await first.text()).toContain('<main data-view="view-stateful">1</main>');
      expect(await second.text()).toContain('<main data-view="view-stateful">2</main>');
    } finally {
      server.stop(true);
    }
  });

  test("fails clearly when the Vite config omits the framework plugin", async () => {
    const root = await createHostFixture();
    await writeFile(
      join(root, "vite.config.ts"),
      `export default { root: ${JSON.stringify(root.replaceAll("\\", "/"))} };`,
    );

    await expect(
      serveViteProgram({
        configFile: join(root, "vite.config.ts"),
        port: 0,
      }),
    ).rejects.toThrow("Vite config must include exactly one stupidFpVite() plugin");
  });

  test("fails clearly when the Vite config registers duplicate framework plugins", async () => {
    const root = await createHostFixture({
      configSource: (fixtureRoot) => viteConfigSource(fixtureRoot, { duplicatePlugin: true }),
    });

    await expect(
      serveViteProgram({
        configFile: join(root, "vite.config.ts"),
        port: 0,
      }),
    ).rejects.toThrow("Vite config includes multiple stupidFpVite() plugins");
  });

  test("generates valid config when html transforms and duplicate plugins are combined", async () => {
    const root = await createHostFixture({
      configSource: (fixtureRoot) =>
        viteConfigSource(fixtureRoot, { duplicatePlugin: true, htmlTransform: true }),
    });

    await expect(
      serveViteProgram({
        configFile: join(root, "vite.config.ts"),
        port: 0,
      }),
    ).rejects.toThrow("Vite config includes multiple stupidFpVite() plugins");
  });

  test("fails clearly when the server entry does not export createProgramHost", async () => {
    const root = await createHostFixture({
      serverSource: "export const notAHost = true;\n",
    });

    await expect(
      serveViteProgram({
        configFile: join(root, "vite.config.ts"),
        port: 0,
      }),
    ).rejects.toThrow("Vite server entry must export createProgramHost(context)");
  });
});

type HostFixtureOptions = {
  serverSource?: string;
  configSource?: string | ((root: string) => string);
};

async function createHostFixture(options: HostFixtureOptions = {}): Promise<string> {
  const root = join(tmpdir(), `stupid-fp-vite-host-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "client.ts"), "console.log('vite host test');\n");
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

function viteConfigSource(
  root: string,
  options?: { duplicatePlugin?: boolean; htmlTransform?: boolean },
): string {
  const plugin = `
    stupidFpVite({
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
    plugin,
    ...(options?.htmlTransform ? [htmlTransformPlugin] : []),
    ...(options?.duplicatePlugin ? [plugin] : []),
  ].join(",");

  return `
import { stupidFpVite } from ${JSON.stringify(relativeImport(root, "src/vite.ts"))};

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
