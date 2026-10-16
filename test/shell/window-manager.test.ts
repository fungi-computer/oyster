import { describe, expect, it } from "vitest";
import type { AppNavigationState } from "@fungi.computer/agar";
import {
  createWindowManager,
  type WindowHost,
  type WindowEvents,
} from "../../src/shell/window-manager.js";

type Launch = Readonly<{ windowId: string; title: string }>;
type Container = Readonly<{ paneId: string }>;

const launch = (windowId: string): Launch => ({ windowId, title: windowId });
function host(dispose: () => void): WindowHost<Launch> {
  return {
    dispose,
    reconfigure: () => undefined,
    setVisibility: () => undefined,
  };
}

describe("renderer-neutral window ownership", () => {
  it("mounts native containers and retires each generation once", async () => {
    const disposed: string[] = [];
    const manager = createWindowManager<Launch, Container>({
      createContainer: ({ windowId }) => ({ paneId: windowId }),
      mount: (container) =>
        host(() => {
          disposed.push(container.paneId);
        }),
    });
    await manager.open(launch("alpha"));
    await manager.open(launch("beta"));
    expect(manager.read().windows.map((window) => window.container)).toEqual([
      { paneId: "alpha" },
      { paneId: "beta" },
    ]);
    await manager.close("alpha");
    expect(manager.read().windows.map((window) => window.windowId)).toEqual([
      "beta",
    ]);
    await manager.dispose();
    await manager.dispose();
    expect(disposed).toEqual(["alpha", "beta"]);
    expect(manager.read().windows).toEqual([]);
  });

  it("aborts close immediately and disposes a native mount arriving late", async () => {
    const pending = Promise.withResolvers<WindowHost<Launch>>();
    const aborted = Promise.withResolvers<undefined>();
    let mountSignal: AbortSignal | undefined;
    let disposed = 0;
    const manager = createWindowManager<Launch, Container>({
      createContainer: ({ windowId }) => ({ paneId: windowId }),
      mount: (_container, _launch, signal) => {
        mountSignal = signal;
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve(undefined);
          },
          { once: true },
        );
        return pending.promise;
      },
    });
    const opening = manager.open(launch("slow"));
    const closing = manager.close("slow");
    await aborted.promise;
    expect(mountSignal?.aborted).toBe(true);
    pending.resolve(
      host(() => {
        disposed += 1;
      }),
    );
    await Promise.all([opening, closing]);
    expect(disposed).toBe(1);
    expect(manager.read().windows).toEqual([]);
    await manager.dispose();
  });

  it("uses the renderer's attachment predicate instead of a DOM property", async () => {
    let mounted = 0;
    const manager = createWindowManager<Launch, Container>({
      createContainer: ({ windowId }) => ({ paneId: windowId }),
      waitForAttachment: true,
      isAttached: () => false,
      mount: () => {
        mounted += 1;
        return host(() => undefined);
      },
    });
    const opening = manager.open(launch("detached"));
    expect(mounted).toBe(0);
    manager.attach("detached");
    await opening;
    expect(mounted).toBe(1);
    await manager.dispose();
  });
});

it("reports a failed mutation with its phase and the original generation", async () => {
  const cause = new Error("fixture disposal failed");
  const failures: unknown[] = [];
  const manager = createWindowManager<Launch, Container>({
    createContainer: ({ windowId }) => ({ paneId: windowId }),
    mount: () =>
      host(() => {
        throw cause;
      }),
    onFailure: (failure) => {
      failures.push(failure);
    },
  });
  await manager.open(launch("failed-close"));
  await expect(manager.close("failed-close")).rejects.toBe(cause);
  expect(failures).toContainEqual({
    windowId: "failed-close",
    generation: 1,
    phase: "mutation",
    cause,
  });
  await expect(manager.dispose()).rejects.toMatchObject({ errors: [cause] });
});

describe("window navigation activations", () => {
  it("delivers only crumbs and enabled commands the App publishes now", async () => {
    const delivered: unknown[] = [];
    let publish: ((state: AppNavigationState | null) => void) | undefined;
    const manager = createWindowManager<Launch, Container>({
      createContainer: ({ windowId }) => ({ paneId: windowId }),
      mount: (_container, _launch, _signal, events) => {
        publish = events.onNavigationState;
        return {
          ...host(() => undefined),
          activateNavigation: (activation) => {
            delivered.push(activation);
            return true;
          },
        };
      },
    });
    await manager.open(launch("trellis"));
    publish?.({
      canGoBack: false,
      crumbs: [
        { id: "app", label: "Trellis" },
        { id: "wf", label: "Flow", siblings: [{ id: "b", label: "B" }] },
      ],
      primary: [{ id: "run", label: "Run" }],
      menu: [{ id: "fork", label: "Fork", disabled: true }],
    });
    const use = (
      activation: Parameters<typeof manager.activateNavigation>[1],
    ) => manager.activateNavigation("trellis", activation);
    await expect(use({ kind: "crumb", crumbId: "app" })).resolves.toBe(true);
    await expect(
      use({ kind: "crumb", crumbId: "wf", siblingId: "b" }),
    ).resolves.toBe(true);
    await expect(use({ kind: "action", actionId: "run" })).resolves.toBe(true);
    await expect(use({ kind: "action", actionId: "fork" })).resolves.toBe(
      false,
    );
    await expect(use({ kind: "crumb", crumbId: "gone" })).resolves.toBe(false);
    await expect(
      use({ kind: "crumb", crumbId: "wf", siblingId: "z" }),
    ).resolves.toBe(false);
    expect(delivered).toHaveLength(3);
    publish?.(null);
    await expect(use({ kind: "crumb", crumbId: "app" })).resolves.toBe(false);
    await manager.dispose();
  });
});

describe("window status actions", () => {
  it("delivers only enabled items and options the App declares now", async () => {
    const delivered: unknown[] = [];
    let report:
      ((items: Parameters<WindowEventsReport>[0]) => void) | undefined;
    const manager = createWindowManager<Launch, Container>({
      createContainer: ({ windowId }) => ({ paneId: windowId }),
      mount: (_container, _launch, _signal, events) => {
        report = events.onStatusItems;
        return {
          ...host(() => undefined),
          activateStatus: (action) => {
            delivered.push(action);
            return true;
          },
        };
      },
    });
    await manager.open(launch("shed"));
    report?.([
      { kind: "text", id: "state", text: "open" },
      { kind: "button", id: "ports", text: "Ports" },
      { kind: "button", id: "off", text: "Off", disabled: true },
      {
        kind: "menu",
        id: "folder",
        text: "media",
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B", disabled: true },
        ],
      },
    ]);
    const use = (action: Parameters<typeof manager.activateStatus>[1]) =>
      manager.activateStatus("shed", action);
    await expect(use({ itemId: "ports" })).resolves.toBe(true);
    await expect(use({ itemId: "folder", optionId: "a" })).resolves.toBe(true);
    // A readout, a removed item, a disabled item or option, a bogus or
    // missing option, and an option on a button never reach the App.
    await expect(use({ itemId: "state" })).resolves.toBe(false);
    await expect(use({ itemId: "gone" })).resolves.toBe(false);
    await expect(use({ itemId: "off" })).resolves.toBe(false);
    await expect(use({ itemId: "folder", optionId: "b" })).resolves.toBe(false);
    await expect(use({ itemId: "folder", optionId: "z" })).resolves.toBe(false);
    await expect(use({ itemId: "folder" })).resolves.toBe(false);
    await expect(use({ itemId: "ports", optionId: "a" })).resolves.toBe(false);
    expect(delivered).toEqual([
      { itemId: "ports" },
      { itemId: "folder", optionId: "a" },
    ]);
    report?.([]);
    await expect(use({ itemId: "ports" })).resolves.toBe(false);
    await manager.dispose();
  });
});

type WindowEventsReport = Parameters<
  Parameters<typeof createWindowManager<Launch, Container>>[0]["mount"]
>[3]["onStatusItems"];

it("routes Computer choice only to the current window picker registration", async () => {
  const mountedEvents: WindowEvents[] = [];
  const opened: string[] = [];
  const manager = createWindowManager<Launch, Container>({
    createContainer: ({ windowId }) => ({ paneId: windowId }),
    mount: (_container, _launch, _signal, events) => {
      mountedEvents.push(events);
      return host(() => undefined);
    },
  });
  await manager.open(launch("alpha"));
  const first = mountedEvents[0];
  if (!first) throw new Error("Expected mounted window events");
  await expect(first.onComputerChoice()).rejects.toMatchObject({
    code: "CAPABILITY_DENIED",
  });
  const unregister = manager.registerComputerChoice("alpha", () => {
    opened.push("alpha");
  });
  await first.onComputerChoice();
  expect(opened).toEqual(["alpha"]);
  unregister();
  await expect(first.onComputerChoice()).rejects.toMatchObject({
    code: "CAPABILITY_DENIED",
  });
  await manager.close("alpha");
  await manager.open(launch("alpha"));
  manager.registerComputerChoice("alpha", () => {
    opened.push("replacement");
  });
  await expect(first.onComputerChoice()).rejects.toMatchObject({
    code: "CAPABILITY_DENIED",
  });
  expect(opened).toEqual(["alpha"]);
  const second = mountedEvents[1];
  if (!second) throw new Error("Expected replacement window events");
  await second.onComputerChoice();
  expect(opened).toEqual(["alpha", "replacement"]);
  await manager.dispose();
  await expect(second.onComputerChoice()).rejects.toMatchObject({
    code: "CAPABILITY_DENIED",
  });
});
