import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveBunProgram, type ClientEnvelope, type ServerEnvelope } from "../src/framework";

type TestMessage = { type: "action.touch" };
type TestProjection = { sessionId: string; value: number };
type TestTrace = { traceId: string; events: unknown[] };

describe("Bun host stream delivery", () => {
  test("delivers returned envelopes to every connected session they target", async () => {
    const root = join(tmpdir(), `stupid-fp-host-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const clientEntry = join(root, "client.ts");
    const shellPath = join(root, "shell.html");
    await writeFile(clientEntry, "console.log('host test');\n");
    await writeFile(shellPath, '<div id="root"></div>\n');

    const server = await serveBunProgram<TestMessage, TestProjection, TestTrace>({
      runtime: createFanoutRuntime(),
      rootDir: root,
      clientEntry,
      shellPath,
      outdir: join(root, "dist"),
      port: 0,
    });

    const port = server.port;

    if (port === undefined) {
      throw new Error("Expected Bun host to bind a port");
    }

    const first = await openSocket(port);
    const second = await openSocket(port);

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
        sessionId: "session-first",
      });
      expect(await readEnvelope(second, "connected")).toMatchObject({
        sessionId: "session-second",
      });
      await readEnvelope(first, "projection:update");
      await readEnvelope(second, "projection:update");

      first.send(
        JSON.stringify({
          type: "message",
          sessionId: "session-first",
          message: { type: "action.touch" },
        } satisfies ClientEnvelope<TestMessage>),
      );

      expect(await readEnvelope(first, "action:result")).toMatchObject({
        sessionId: "session-first",
        ok: true,
      });
      expect(await readEnvelope(second, "projection:patch")).toMatchObject({
        sessionId: "session-second",
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

  test("can render an initial HTML snapshot with stream bootstrap state", async () => {
    const root = join(tmpdir(), `stupid-fp-host-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const clientEntry = join(root, "client.ts");
    const shellPath = join(root, "shell.html");
    await writeFile(clientEntry, "console.log('host test');\n");
    await writeFile(
      shellPath,
      '<html><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>',
    );

    const server = await serveBunProgram<TestMessage, TestProjection, TestTrace>({
      runtime: createFanoutRuntime(),
      rootDir: root,
      clientEntry,
      shellPath,
      outdir: join(root, "dist"),
      port: 0,
      initialRender: {
        resolve: () => ({ route: "/test", params: { id: "initial" } }),
        render: (bootstrap) =>
          `<main data-session="${bootstrap.sessionId}">${bootstrap.projection.value}</main>`,
      },
    });

    try {
      const response = await fetch(`http://localhost:${server.port}/`);
      const html = await response.text();

      expect(response.headers.get("content-type")).toContain("text/html");
      expect(html).toContain('<div id="root"><main data-session="session-initial">0</main></div>');
      expect(html).toContain("window.__STUPID_FP_BOOTSTRAP__=");
      expect(html).toContain('"sessionId":"session-initial"');
      expect(html).toContain('"projectionVersion":1');
    } finally {
      server.stop(true);
    }
  });
});

function createFanoutRuntime() {
  return {
    async connect(envelope: Extract<ClientEnvelope<TestMessage>, { type: "connect" }>) {
      const sessionId = `session-${envelope.params.id}`;

      return {
        envelopes: [
          {
            type: "connected",
            sessionId,
            cursor: `${sessionId}-cursor-1`,
            resumed: false,
            resume: { status: "fresh" },
          },
          {
            type: "projection:update",
            sessionId,
            cursor: `${sessionId}-cursor-2`,
            projectionVersion: 1,
            projection: { sessionId, value: 0 },
            regions: [],
          },
        ] satisfies ServerEnvelope<TestProjection, TestTrace>[],
      };
    },
    async receive() {
      return {
        envelopes: [
          {
            type: "action:result",
            sessionId: "session-first",
            cursor: "cursor-action",
            traceId: "trace-1",
            action: "touch",
            ok: true,
          },
          {
            type: "projection:patch",
            sessionId: "session-second",
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
        ] satisfies ServerEnvelope<TestProjection, TestTrace>[],
      };
    },
  };
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
