import { afterEach, expect, it, vi } from "vitest";
import { desktopApp } from "../../src/standalone/local-desktop.js";
import { standaloneAppSet } from "../../src/standalone/app-set.js";
import {
  tryEffects,
  type StarterInstalls,
} from "../../src/standalone/try-cli.js";

const local = {
  desktopState: vi.fn<StarterInstalls["desktopState"]>(),
  installed: vi.fn<StarterInstalls["installed"]>(),
  isOlder: vi.fn<StarterInstalls["isOlder"]>(),
  install: vi.fn<StarterInstalls["install"]>(),
};
const effects = () => tryEffects(undefined, local);

const warn = vi.fn();
const base = {
  url: "http://127.0.0.1:1",
  key: "k",
  packageStoreDirectory: "/store",
  signal: new AbortController().signal,
  warn,
};
const grove = standaloneAppSet.find((app) => app.installationId === "grove");
if (grove === undefined) throw new Error("grove is a starter App");

afterEach(() => {
  vi.clearAllMocks();
});

it("replaces a saved desktop an older Oyster built", async () => {
  local.desktopState.mockResolvedValueOnce("ready");
  local.desktopState.mockResolvedValueOnce("ready");
  local.isOlder.mockResolvedValue(true);
  const state = await effects().installDesktop({
    ...base,
    directory: "/project",
  });
  expect(state).toBe("ready");
  expect(local.install).toHaveBeenCalledWith(
    desktopApp,
    expect.objectContaining({ url: base.url }),
  );
  expect(local.isOlder).toHaveBeenCalledWith(
    desktopApp,
    expect.objectContaining({ warn }),
  );
});

it("keeps a saved desktop this Oyster built", async () => {
  local.desktopState.mockResolvedValue("ready");
  local.isOlder.mockResolvedValue(false);
  expect(
    await effects().installDesktop({ ...base, directory: "/project" }),
  ).toBe("ready");
  expect(local.install).not.toHaveBeenCalled();
});

it("replaces a saved starter an older Oyster built, and keeps a current one", async () => {
  local.installed.mockResolvedValue(true);
  local.isOlder.mockResolvedValueOnce(true);
  expect(await effects().installStarter(grove, base)).toBe("installed");
  expect(local.install).toHaveBeenCalledTimes(1);
  local.isOlder.mockResolvedValueOnce(false);
  expect(await effects().installStarter(grove, base)).toBe("already-installed");
  expect(local.install).toHaveBeenCalledTimes(1);
});
