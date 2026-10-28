// @vitest-environment jsdom
import {
  connectApp,
  type AppRoot,
  type AppConnectMessage,
  type AppReadyMessage,
} from "@fungi.computer/agar";
import {
  agentSessionRead,
  agentSessionWrite,
} from "@fungi.computer/agar/agents";
import type { AppHost } from "@fungi.computer/agar/host";
import { afterEach, expect, it, vi } from "vitest";
import { Knapsack, type UiConnection } from "@fungi.computer/knapsack";
import { z } from "zod";
import { mountOysterPage, type OysterAppConfig } from "../../src/page/mount.js";
import {
  fetchUiResponse,
  invokeUi,
  useNativeFetchRequest,
} from "./agent-browser.fixture.js";

let app: AppRoot | undefined;
let host: AppHost | undefined;
let connectionAbort: AbortController | undefined;
let pending: (Promise<AppRoot> | Promise<AppHost>)[] = [];
let browserUi: UiConnection | undefined;

afterEach(async () => {
  app?.dispose();
  host?.dispose();
  app = undefined;
  host = undefined;
  connectionAbort?.abort();
  connectionAbort = undefined;
  window.dispatchEvent(new Event("pagehide"));
  await Promise.allSettled(pending);
  await browserUi?.close();
  browserUi = undefined;
  pending = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([
  { writable: true, closing: "pagehide" },
  { writable: true, closing: "disconnect" },
  { writable: false, closing: "pagehide" },
])(
  "serves only admitted commands (write=$writable) until $closing",
  async ({ writable, closing }) => {
    useNativeFetchRequest();
    const write = new Request("https://fixture.invalid", {
      method: "POST",
      body: "{}",
    });
    expect(new Request(new URL(write.url), write).method).toBe("POST");
    const command = {
      id: "set-scene",
      title: "Set scene",
      category: "Stage",
      projections: { agent: {} },
    };
    const replacement = {
      ...command,
      id: "replace-scene",
      title: "Replace scene",
    };
    const config: OysterAppConfig = {
      workbench: false,
      shellModuleUrl: null,
      storage: false,
      appsOpen: false,
      computerId: null,
      authorityVersion: 1,
      commands: [command, replacement],
      icon: null,
      roles: [],
      installationId: "stage",
      appId: "app_stage",
      releaseId: "release_stage",
      uiUrl: "/ui/stage/",
      backendUrl: "/backend/stage/",
      methodsUrl: "/methods/stage/",
      capabilities: (writable
        ? [agentSessionRead, agentSessionWrite]
        : [agentSessionRead]
      ).map((contract) => ({
        id: contract.id,
        version: contract.version,
        base: "/",
        methods: {
          open: {
            kind: "transport",
            method: contract.id === agentSessionRead.id ? "GET" : "ANY",
            path: "agents/:agentId",
          },
          openInbox: {
            kind: "transport",
            method: contract.id === agentSessionRead.id ? "GET" : "ANY",
            path: "member",
          },
        },
      })),
    };
    const configElement = document.createElement("script");
    configElement.id = "oyster-config";
    configElement.type = "application/json";
    configElement.textContent = JSON.stringify(config);
    const frame = document.createElement("iframe");
    frame.id = "oyster-app";
    document.body.append(configElement, frame);
    const child = frame.contentWindow;
    if (child === null) throw new Error("The test App frame is missing");
    const parent = window;
    // Vitest copies host globals onto its runner; keep the child's peer the
    // actual host Window, as it is in a browser, not that globals facade.
    Object.defineProperty(child, "parent", {
      value: parent,
      configurable: true,
    });

    vi.stubGlobal("OYSTER_SHELL_STYLES", "");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const ui = Knapsack.ui({
      id: "page-ui",
      hasSession: (id) =>
        Promise.resolve(["session_stage", "session_second"].includes(id)),
    });
    browserUi = ui;
    const requests: Request[] = [];
    const admittedFetch: typeof globalThis.fetch = (input, init) => {
      const path = z.string().safeParse(input);
      const request = new Request(
        path.success ? new URL(path.data, parent.location.href) : input,
        init,
      );
      expect(request.headers.get("X-Oyster-Installation")).toBe("stage");
      const url = new URL(request.url);
      expect(url.pathname.startsWith("/agents/agent_stage/browser/")).toBe(
        true,
      );
      requests.push(request);
      url.pathname = url.pathname.slice("/agents/agent_stage".length);
      return fetchUiResponse(ui, new Request(url, request));
    };
    vi.stubGlobal("fetch", admittedFetch);

    // JSDOM has real Windows but no transferable postMessage implementation.
    // Deliver native MessagePorts between those same Windows; Agar still owns
    // ready/connect parsing, peer identity, RPC and connection disposal.
    const postParent = vi
      .spyOn(parent, "postMessage")
      .mockImplementation((data: AppReadyMessage) => {
        parent.dispatchEvent(
          new MessageEvent("message", {
            data,
            origin: "null",
            source: child,
          }),
        );
      });
    const postChild = vi
      .spyOn(child, "postMessage")
      .mockImplementation(
        (
          data: AppConnectMessage,
          _origin?: string | WindowPostMessageOptions,
          transfer?: Transferable[],
        ) => {
          const event = new MessageEvent("message", {
            data,
            origin: parent.location.origin,
            source: parent,
          });
          Object.defineProperty(event, "ports", { value: transfer ?? [] });
          child.dispatchEvent(event);
        },
      );
    const listening = vi.spyOn(parent, "addEventListener");
    const mounting = mountOysterPage();
    pending = [mounting];
    await vi.waitFor(() => {
      expect(listening.mock.calls.some(([name]) => name === "message")).toBe(
        true,
      );
    });
    let connecting: Promise<AppRoot>;
    connectionAbort = new AbortController();
    vi.stubGlobal("window", child);
    try {
      connecting = connectApp({
        host: "parent",
        signal: connectionAbort.signal,
      });
    } finally {
      vi.stubGlobal("window", parent);
    }
    pending = [mounting, connecting];
    expect(postParent).toHaveBeenCalledOnce();
    expect(postChild).toHaveBeenCalledOnce();
    [host, app] = await Promise.all([mounting, connecting]);
    const handler = vi.fn(() => "scene updated");
    const remove = await app.commands.register(command, handler);
    await app.ui.reportAgentSessionSelection({
      agentId: "agent_stage",
      sessionId: "session_stage",
    });
    if (!writable) {
      expect(requests).toHaveLength(0);
      return;
    }
    await vi.waitFor(() => {
      expect(
        requests.filter((request) => request.method === "GET"),
      ).toHaveLength(1);
    });
    const firstDiscovery = await invokeUi(ui, "session_stage", "discover");
    expect(firstDiscovery).toMatchObject({
      status: "available",
      commands: [{ command: { namespace: "stage", id: "set-scene" } }],
    });
    expect(await invokeUi(ui, "session_stage", "execute")).toEqual({
      status: "handled",
      result: "scene updated",
    });
    expect(handler).toHaveBeenCalledOnce();
    remove();
    await app.commands.register(replacement, () => "scene replaced");
    expect(await invokeUi(ui, "session_stage", "discover")).toMatchObject({
      status: "available",
      commands: [{ command: { namespace: "stage", id: "replace-scene" } }],
    });
    expect(await invokeUi(ui, "session_stage", "execute")).toEqual({
      status: "missing",
    });
    await app.ui.reportAgentSessionSelection({
      agentId: "agent_stage",
      sessionId: "session_second",
    });
    await vi.waitFor(() => {
      expect(
        requests.filter((request) => request.method === "GET"),
      ).toHaveLength(2);
      expect(requests[0]?.signal.aborted).toBe(true);
    });
    expect(await invokeUi(ui, "session_stage", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    expect(
      await invokeUi(ui, "session_second", "execute", {
        namespace: "stage",
        id: "replace-scene",
      }),
    ).toEqual({
      status: "handled",
      result: "scene replaced",
    });
    await app.ui.reportAgentSessionSelection(null);
    expect(await invokeUi(ui, "session_second", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
    expect(
      new Set(
        requests
          .filter((request) => request.method === "POST")
          .map((request) => new URL(request.url).pathname.split("/").at(-1)),
      ),
    ).toEqual(new Set(["claims", "results"]));
    await app.ui.reportAgentSessionSelection({
      agentId: "agent_stage",
      sessionId: "session_stage",
    });
    expect(await invokeUi(ui, "session_stage", "discover")).toMatchObject({
      status: "available",
      commands: [{ command: { namespace: "stage", id: "replace-scene" } }],
    });
    if (closing === "pagehide") parent.dispatchEvent(new Event("pagehide"));
    else await host.disconnect();
    await vi.waitFor(() => {
      expect(
        requests.filter((request) => request.method === "GET").at(-1)?.signal
          .aborted,
      ).toBe(true);
    });
    expect(await invokeUi(ui, "session_stage", "discover")).toEqual({
      status: "unavailable",
      reason: "browser_not_connected",
    });
  },
  // Measured 2026-10-25: the first case (it pays the file's cold jsdom frame,
  // Knapsack UI and Agar session setup) takes about 0.2 s idle and at most
  // 0.8 s with four times more busy processes than cores plus the whole Oyster
  // vitest suite; 48 runs eight-wide under that load peaked at 0.6 s. Batch
  // 2137 still timed it out at the 5 s default while its sibling cases ran at
  // normal loaded speed, so the gate can stall it far beyond what load here
  // reproduces. 15 s keeps a real hang failing well inside the file's budget.
  15_000,
);
