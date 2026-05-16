import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildViteProgram, serveViteProgram } from "../src/vite";
import type { ClientEnvelope, ServerEnvelope } from "../src/framework";

type TestMessage = { type: "action.touch" };
type TestProjection = { viewId: string; value: number };
type TestTrace = { traceId: string; events: unknown[] };

describe("Vite host stream delivery", () => {
  test("delivers returned envelopes to every connected view they target", async () => {
    const root = await createHostFixture();
    const server = await serveViteProgram({
      root,
      template: join(root, "index.html"),
      clientEntry: join(root, "client.ts"),
      serverEntry: join(root, "server.ts"),
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
      root,
      template: join(root, "index.html"),
      clientEntry: join(root, "client.ts"),
      serverEntry: join(root, "server.ts"),
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
      expect(html).toContain("/client.ts");
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
      root,
      template: join(root, "index.html"),
      clientEntry: join(root, "client.ts"),
      serverEntry: join(root, "server.ts"),
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
      expect(html).toContain("/client.ts");
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
    const root = await createHostFixture();
    await mkdir(join(root, "public", ".well-known"), { recursive: true });
    await writeFile(join(root, "public", "favicon.svg"), "<svg>production</svg>\n");
    await writeFile(join(root, "public", ".well-known", "security"), "contact=production\n");
    const outDir = join(root, "dist");

    await buildViteProgram({
      root,
      template: join(root, "index.html"),
      clientEntry: join(root, "client.ts"),
      serverEntry: join(root, "server.ts"),
      outDir,
      mode: "production",
    });

    const server = await serveViteProgram({
      root,
      template: join(root, "index.html"),
      clientEntry: join(root, "client.ts"),
      serverEntry: join(root, "server.ts"),
      outDir,
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
});

async function createHostFixture(): Promise<string> {
  const root = join(tmpdir(), `stupid-fp-vite-host-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "client.ts"), "console.log('vite host test');\n");
  await writeFile(join(root, "index.html"), '<html><body><div id="root"></div></body></html>');
  await writeFile(join(root, "server.ts"), serverEntrySource());
  return root;
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

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://localhost:${port}/stream`);

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), {
      once: true,
    });
  });

  return socket;
}

async function readEnvelope(
  socket: WebSocket,
  type: ServerEnvelope<TestProjection, TestTrace>["type"],
): Promise<ServerEnvelope<TestProjection, TestTrace>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 1000);

    function onMessage(event: MessageEvent) {
      const envelope = JSON.parse(String(event.data)) as ServerEnvelope<TestProjection, TestTrace>;

      if (envelope.type !== type) {
        return;
      }

      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(envelope);
    }

    socket.addEventListener("message", onMessage);
  });
}
