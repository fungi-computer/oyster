// @vitest-environment jsdom
import { createCapabilityRegistry } from "@fungi.computer/agar";
import {
  agentSessionRead,
  agentSessionWrite,
} from "@fungi.computer/agar/agents";
import { RpcStub } from "@fungi.computer/capnweb";
import { Knapsack } from "@fungi.computer/knapsack";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { capabilityHandle } from "../../src/page/capabilities.js";
import { OysterAgentBrowserHost } from "../../src/page/mount.js";
import {
  fetchUiResponse,
  invokeUi,
  useNativeFetchRequest,
} from "./agent-browser.fixture.js";

function directoryFor(installationId: string) {
  const directory = createCapabilityRegistry();
  const read = capabilityHandle(
    {
      id: agentSessionRead.id,
      version: agentSessionRead.version,
      base: "/",
      methods: {
        open: { kind: "transport", method: "GET", path: "agents/:agentId" },
      },
    },
    installationId,
  );
  const write = capabilityHandle(
    {
      id: agentSessionWrite.id,
      version: agentSessionWrite.version,
      base: "/",
      methods: {
        open: { kind: "transport", method: "ANY", path: "agents/:agentId" },
      },
    },
    installationId,
  );
  directory.provide(
    agentSessionRead,
    agentSessionRead.schema.parse(new RpcStub(read)),
  );
  directory.provide(
    agentSessionWrite,
    agentSessionWrite.schema.parse(new RpcStub(write)),
  );
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("one page owner isolates mounts and identically named Sessions across Agents", async () => {
  useNativeFetchRequest();
  const control = new AbortController();
  const browser = new OysterAgentBrowserHost(control.signal);
  const commands = createAppSurfaceCommandHost();
  const paint = {
    id: "paint",
    title: "Paint",
    category: "Fixture",
    projections: { agent: {} },
  };
  const human = {
    id: "human",
    title: "Human",
    category: "Fixture",
    projections: { palette: {} },
  };
  const first = commands.mount("first", [paint, human]);
  const second = commands.mount("second", [paint]);
  const firstFrame = document.createElement("iframe");
  const secondFrame = document.createElement("iframe");
  const firstUi = Knapsack.ui({
    id: "first-ui",
    hasSession: (id) => Promise.resolve(id === "shared"),
  });
  const secondUi = Knapsack.ui({
    id: "second-ui",
    hasSession: (id) => Promise.resolve(id === "shared"),
  });
  const uiByAgent = new Map([
    ["agent_first", firstUi],
    ["agent_second", secondUi],
  ]);
  const requests: Request[] = [];
  const routes = new Hono();
  routes.all("/agents/:agentId/*", async (context) => {
    const agentId = context.req.param("agentId");
    const ui = uiByAgent.get(agentId);
    if (ui === undefined) return context.notFound();
    const request = context.req.raw;
    expect(["first", "second"]).toContain(
      request.headers.get("X-Oyster-Installation"),
    );
    requests.push(request);
    const target = new URL(request.url);
    target.pathname = target.pathname.slice(`/agents/${agentId}`.length);
    return await fetchUiResponse(ui, new Request(target, request));
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = z.string().safeParse(input);
    return await routes.fetch(
      new Request(
        path.success ? new URL(path.data, "https://oyster.invalid") : input,
        init,
      ),
    );
  };
  vi.stubGlobal("fetch", fetch);
  const firstDirectory = directoryFor("first");
  const secondDirectory = directoryFor("second");
  const invoke = vi.fn(() => Promise.resolve("first"));
  try {
    await first.handlers.registerCommands({ commands: [paint, human], invoke });
    await second.handlers.registerCommands({
      commands: [paint],
      invoke: () => Promise.resolve("second"),
    });
    await browser.report(
      firstFrame,
      { agentId: "agent_first", sessionId: "shared" },
      firstDirectory,
      first.agentCommands,
    );
    expect(
      await invokeUi(firstUi, "shared", "execute", {
        namespace: "first",
        id: "paint",
      }),
    ).toEqual({ status: "handled", result: "first" });
    expect(await invokeUi(firstUi, "unselected", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    for (const command of [
      { namespace: "second", id: "paint" },
      { namespace: "first", id: "human" },
    ])
      expect(await invokeUi(firstUi, "shared", "execute", command)).toEqual({
        status: "missing",
      });
    expect(invoke).toHaveBeenCalledOnce();

    await browser.report(
      secondFrame,
      { agentId: "agent_second", sessionId: "shared" },
      secondDirectory,
      second.agentCommands,
    );
    await browser.report(firstFrame, null, firstDirectory, first.agentCommands);
    browser.release(firstFrame);
    expect(await invokeUi(firstUi, "shared", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    expect(await invokeUi(secondUi, "shared", "discover")).toMatchObject({
      status: "available",
      commands: [{ command: { namespace: "second", id: "paint" } }],
    });
    expect(
      await invokeUi(secondUi, "shared", "execute", {
        namespace: "first",
        id: "paint",
      }),
    ).toEqual({ status: "missing" });
    expect(
      await invokeUi(secondUi, "shared", "execute", {
        namespace: "second",
        id: "paint",
      }),
    ).toEqual({ status: "handled", result: "second" });

    const streams = requests.filter((request) => request.method === "GET");
    expect(
      streams.map((request) => request.headers.get("X-Oyster-Installation")),
    ).toEqual(["first", "second"]);
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(streams[1]?.signal.aborted).toBe(false);
    control.abort();
    expect(await invokeUi(secondUi, "shared", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    await browser.report(
      firstFrame,
      { agentId: "agent_first", sessionId: "shared" },
      firstDirectory,
      first.agentCommands,
    );
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(
      2,
    );
    expect(streams[1]?.signal.aborted).toBe(true);
  } finally {
    control.abort();
    browser.dispose();
    commands.dispose();
    await Promise.all([firstUi.close(), secondUi.close()]);
  }
});
