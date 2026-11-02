// @vitest-environment jsdom
import { AppError } from "@fungi.computer/agar";
import { afterEach, expect, it, vi } from "vitest";
import { mountOysterPage, type OysterAppConfig } from "../../src/page/mount.js";

const config: OysterAppConfig = {
  workbench: false,
  shellModuleUrl: null,
  storage: false,
  appsOpen: false,
  computerId: null,
  authorityVersion: 1,
  commands: [],
  icon: null,
  roles: [],
  installationId: "grove",
  appId: "app_grove",
  releaseId: "release_grove",
  uiUrl: "/ui/grove/release_grove/",
  backendUrl: "/backend/grove/",
  methodsUrl: "/methods/grove/",
  capabilities: [],
};

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/**
 * The served page: its config and an App frame the host has not navigated.
 * JSDOM runs no App document, so navigation is only recorded here.
 */
function servedPage() {
  const configElement = document.createElement("script");
  configElement.id = "oyster-config";
  configElement.type = "application/json";
  configElement.textContent = JSON.stringify(config);
  const frame = document.createElement("iframe");
  frame.id = "oyster-app";
  document.body.append(configElement, frame);
  vi.stubGlobal("OYSTER_SHELL_STYLES", "");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const navigations: string[] = [];
  Object.defineProperty(frame, "src", {
    configurable: true,
    set: (value: string) => {
      navigations.push(value);
    },
  });
  return { frame, navigations };
}

it("listens for the App's ready signal before its document starts loading", async () => {
  const { frame } = servedPage();
  const listening = vi.spyOn(window, "addEventListener");
  let heard: (listening: boolean) => void = () => undefined;
  const navigated = new Promise<boolean>((resolve) => {
    heard = resolve;
  });
  // A cold Oyster can resolve capabilities after the App has already sent
  // (and stopped re-sending) its ready signal; the host must hear the first.
  Object.defineProperty(frame, "src", {
    configurable: true,
    set: (value: string) => {
      expect(value).toBe(config.uiUrl);
      heard(listening.mock.calls.some(([name]) => name === "message"));
    },
  });
  const outcome = mountOysterPage().then(
    () => "opened",
    (cause: unknown) => cause,
  );
  expect(await navigated).toBe(true);
  // Leaving the page cancels the open that has no App behind it.
  window.dispatchEvent(new Event("pagehide"));
  expect(await outcome).toMatchObject({ code: "CANCELLED" });
});

it.each([
  { phase: "document", loaded: false, bound: 30_000 },
  { phase: "handshake", loaded: true, bound: 10_000 },
])(
  "fails a silent App $phase after $bound ms instead of opening forever",
  async ({ loaded, bound }) => {
    const { frame, navigations } = servedPage();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opening = mountOysterPage();
    const outcome = opening.then(
      () => "opened",
      (cause: unknown) => cause,
    );
    // Capability resolution settles without any timer; no time has passed.
    await vi.advanceTimersByTimeAsync(0);
    expect(navigations).toEqual([config.uiUrl]);
    if (loaded) frame.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(bound - 1);
    expect(
      await Promise.race([outcome, Promise.resolve("still opening")]),
    ).toBe("still opening");
    await vi.advanceTimersByTimeAsync(1);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "TIMEOUT", retryable: true });
  },
);
