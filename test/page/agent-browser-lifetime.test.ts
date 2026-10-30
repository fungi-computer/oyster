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
import { OysterAgentBrowserHost } from "../../src/page/agent-browser.js";
import {
  discoverUiCommand,
  discoverUiCommands,
  fetchUiResponse,
  invokeUi,
  useNativeFetchRequest,
} from "./agent-browser.fixture.js";

function directoryFor(installationId: string, writable = true) {
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
  if (writable)
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

it("shares only this admitted desktop's live Agent commands, not another page's windows", async () => {
  useNativeFetchRequest();
  const control = new AbortController();
  const page = new OysterAgentBrowserHost(control.signal);
  const otherPage = new OysterAgentBrowserHost(control.signal);
  const visitor = new OysterAgentBrowserHost(control.signal);
  const commands = createAppSurfaceCommandHost();
  const edit = {
    id: "set-generation-draft",
    title: "Edit draft",
    category: "Generation",
    projections: { agent: {} },
  };
  const submit = { ...edit, id: "submit-generation-draft", title: "Generate" };
  const human = { ...edit, id: "human", projections: { palette: {} } };
  const grove = document.createElement("iframe");
  const prints = document.createElement("iframe");
  const other = document.createElement("iframe");
  const visitorFrame = document.createElement("iframe");
  const groveCommands = commands.mount("grove", []);
  const printsCommands = commands.mount("prints", [edit, submit, human]);
  const otherCommands = commands.mount("other", [edit]);
  const readOnlyCommands = commands.mount("read-only", []);
  const invoke = vi.fn(() => Promise.resolve("updated"));
  const otherInvoke = vi.fn(() => Promise.resolve("private"));
  const firstUi = Knapsack.ui({
    id: "desktop",
    hasSession: (id) => Promise.resolve(id === "shared"),
  });
  const otherUi = Knapsack.ui({
    id: "other-desktop",
    hasSession: (id) => Promise.resolve(id === "shared"),
  });
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = z.string().safeParse(input);
      const request = new Request(
        path.success ? new URL(path.data, "https://oyster.invalid") : input,
        init,
      );
      requests.push(request);
      const url = new URL(request.url);
      const other = url.pathname.startsWith("/agents/agent_other/");
      expect(request.headers.get("X-Oyster-Installation")).toBe(
        other ? "other" : "grove",
      );
      url.pathname = url.pathname.slice(
        (other ? "/agents/agent_other" : "/agents/agent_desktop").length,
      );
      return fetchUiResponse(
        other ? otherUi : firstUi,
        new Request(url, request),
      );
    },
  );
  try {
    await printsCommands.handlers.registerCommands({
      commands: [edit, submit, human],
      invoke,
    });
    await otherCommands.handlers.registerCommands({
      commands: [edit],
      invoke: otherInvoke,
    });
    page.mount(grove, groveCommands.agentCommands);
    const closePrints = page.mount(prints, printsCommands.agentCommands);
    otherPage.mount(other, otherCommands.agentCommands);
    visitor.mount(visitorFrame, printsCommands.agentCommands);
    await visitor.report(
      visitorFrame,
      { agentId: "agent_desktop", sessionId: "shared" },
      directoryFor("visitor", false),
    );
    expect(requests).toHaveLength(0);
    await page.report(
      grove,
      { agentId: "agent_desktop", sessionId: "shared" },
      directoryFor("grove"),
    );
    await otherPage.report(
      other,
      { agentId: "agent_other", sessionId: "shared" },
      directoryFor("other"),
    );
    const discovered = await discoverUiCommands(firstUi, "shared");
    expect(discovered.map((row) => row.command.id)).toEqual([
      edit.id,
      submit.id,
    ]);
    const editKey = await discoverUiCommand(firstUi, "shared", edit.id);
    const submitKey = await discoverUiCommand(firstUi, "shared", submit.id);
    expect(await invokeUi(firstUi, "shared", "execute", editKey)).toEqual({
      status: "handled",
      result: "updated",
    });
    expect(await invokeUi(firstUi, "shared", "execute", submitKey)).toEqual({
      status: "handled",
      result: "updated",
    });
    expect(invoke.mock.calls).toHaveLength(2);
    expect(
      await invokeUi(firstUi, "shared", "execute", { ...editKey, id: "human" }),
    ).toEqual({ status: "missing" });
    const foreignKey = await discoverUiCommand(otherUi, "shared", edit.id);
    expect(await invokeUi(firstUi, "shared", "execute", foreignKey)).toEqual({
      status: "missing",
    });
    expect(await invokeUi(otherUi, "shared", "execute", editKey)).toEqual({
      status: "missing",
    });
    expect(otherInvoke).not.toHaveBeenCalled();
    // A read-only report cannot replace the existing writable selection.
    page.mount(visitorFrame, readOnlyCommands.agentCommands);
    await page.report(
      visitorFrame,
      { agentId: "agent_other", sessionId: "shared" },
      directoryFor("visitor", false),
    );
    expect(await discoverUiCommands(firstUi, "shared")).toHaveLength(2);
    closePrints();
    expect(await discoverUiCommands(firstUi, "shared")).toEqual([]);
    expect(await invokeUi(firstUi, "shared", "execute", submitKey)).toEqual({
      status: "missing",
    });
    control.abort();
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(
      2,
    );
  } finally {
    control.abort();
    commands.dispose();
    await Promise.all([firstUi.close(), otherUi.close()]);
  }
});

it.each(["resolve", "reject"] as const)(
  "withdraws closed-window keys and discards a claimed %s across a same-frame reopen",
  async (settlement) => {
    useNativeFetchRequest();
    const control = new AbortController();
    const browser = new OysterAgentBrowserHost(control.signal);
    const commands = createAppSurfaceCommandHost();
    const definition = {
      id: "submit",
      title: "Submit",
      category: "Fixture",
      projections: { agent: {} },
    };
    const grove = document.createElement("iframe");
    const prints = document.createElement("iframe");
    const selection = commands.mount("grove", []);
    const first = commands.mount("prints", [definition]);
    let finish: (value: string) => void = () => undefined;
    let fail: (cause: Error) => void = () => undefined;
    const result = new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const ui = Knapsack.ui({
      id: "window-lifetime",
      hasSession: (id) => Promise.resolve(id === "session"),
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = z.string().safeParse(input);
      const request = new Request(
        path.success ? new URL(path.data, "https://oyster.invalid") : input,
        init,
      );
      const url = new URL(request.url);
      url.pathname = url.pathname.slice("/agents/agent_desktop".length);
      return fetchUiResponse(ui, new Request(url, request));
    });
    try {
      await first.handlers.registerCommands({
        commands: [definition],
        invoke: () => {
          signalStarted();
          return result;
        },
      });
      browser.mount(grove, selection.agentCommands);
      const close = browser.mount(prints, first.agentCommands);
      await browser.report(
        grove,
        { agentId: "agent_desktop", sessionId: "session" },
        directoryFor("grove"),
      );
      const oldKey = await discoverUiCommand(ui, "session", "submit");
      const pending = invokeUi(ui, "session", "execute", oldKey);
      await started;
      close();
      first.dispose();
      const replacement = commands.mount("prints", [definition]);
      const nextInvoke = vi.fn(() => Promise.resolve("new window"));
      await replacement.handlers.registerCommands({
        commands: [definition],
        invoke: nextInvoke,
      });
      browser.mount(prints, replacement.agentCommands);
      // Knapsack admits one outstanding UI request per Session. Reopen while
      // execution is claimed, then settle it before issuing another discovery.
      if (settlement === "resolve") finish("departed window");
      else fail(new Error("Departed App disconnected"));
      expect(await pending).toMatchObject({
        status: "failed",
        error: { code: "window_command_detached" },
      });
      const newKey = await discoverUiCommand(ui, "session", "submit");
      expect(newKey).not.toEqual(oldKey);
      expect(await invokeUi(ui, "session", "execute", oldKey)).toEqual({
        status: "missing",
      });
      expect(nextInvoke).not.toHaveBeenCalled();
      expect(await invokeUi(ui, "session", "execute", newKey)).toEqual({
        status: "handled",
        result: "new window",
      });
    } finally {
      finish("cleanup");
      control.abort();
      commands.dispose();
      await ui.close();
    }
  },
);

it("one page owner releases departed windows and identically named Sessions across Agents", async () => {
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
  const closeFirst = browser.mount(firstFrame, first.agentCommands);
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
    );
    const firstKey = await discoverUiCommand(firstUi, "shared", "paint");
    expect(await invokeUi(firstUi, "shared", "execute", firstKey)).toEqual({
      status: "handled",
      result: "first",
    });
    expect(await invokeUi(firstUi, "unselected", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    for (const command of [
      { namespace: "second", id: "paint" },
      { ...firstKey, id: "human" },
    ])
      expect(await invokeUi(firstUi, "shared", "execute", command)).toEqual({
        status: "missing",
      });
    expect(invoke).toHaveBeenCalledOnce();

    browser.mount(secondFrame, second.agentCommands);
    closeFirst();
    await browser.report(
      secondFrame,
      { agentId: "agent_second", sessionId: "shared" },
      secondDirectory,
    );
    await browser.report(firstFrame, null, firstDirectory);
    browser.release(firstFrame);
    expect(await invokeUi(firstUi, "shared", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    const secondKey = await discoverUiCommand(secondUi, "shared", "paint");
    expect(await invokeUi(secondUi, "shared", "execute", firstKey)).toEqual({
      status: "missing",
    });
    expect(await invokeUi(secondUi, "shared", "execute", secondKey)).toEqual({
      status: "handled",
      result: "second",
    });

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
