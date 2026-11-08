import { afterEach, expect, it, vi } from "vitest";
import {
  localDesktopState,
  starterCloneArguments,
  starterReleaseTag,
} from "../../src/standalone/local-desktop.js";
import { standaloneAppSet } from "../../src/standalone/app-set.js";
import { approvedInstallation } from "../../src/testing/installation.js";
import { declaration, release } from "../apps-fixture.js";

const input = { url: "http://127.0.0.1:8787", key: "test-owner" };
const installed = () =>
  approvedInstallation({
    declaration,
    release,
    installationId: "tourtois",
    instanceId: null,
  });

afterEach(() => vi.unstubAllGlobals());

it.each([
  [200, "ready"],
  [403, "approval-required"],
  [404, "unavailable"],
  [503, "unavailable"],
] as const)(
  "defers shell readiness to the host entry (%s)",
  async (status, state) => {
    const saved = await installed();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(new Response(null, { status }));
    vi.stubGlobal("fetch", request);
    expect(await localDesktopState(input)).toBe(state);
    expect(request).toHaveBeenNthCalledWith(
      1,
      new URL("/api/installations", input.url),
      { headers: { Authorization: "Bearer test-owner" } },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      new URL(`/ui-entry/tourtois/${release.releaseId}/shell.js`, input.url),
      undefined,
    );
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it.each(["disabled", "deleted"] as const)(
  "preserves an explicit %s record",
  async (status) => {
    const saved = { ...(await installed()), status };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([saved]));
    vi.stubGlobal("fetch", request);
    expect(await localDesktopState(input)).toBe(status);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("only treats a successful empty registry read as missing", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(Response.json([{ installationId: "tourtois" }]));
  vi.stubGlobal("fetch", request);
  expect(await localDesktopState(input)).toBe("missing");
  await expect(localDesktopState(input)).rejects.toThrow("HTTP 403");
  await expect(localDesktopState(input)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(3);
});

it("pins each starter App to the release tag of this Oyster's version", async () => {
  const tag = await starterReleaseTag();
  expect(tag).toMatch(/^v\d+\.\d+\.\d+/u);
  const grove = standaloneAppSet.find((app) => app.installationId === "grove");
  if (grove === undefined) throw new Error("grove is a starter App");
  expect(starterCloneArguments(grove, tag, "/scratch/grove")).toEqual([
    "clone",
    "--quiet",
    "--depth=1",
    `--branch=${tag}`,
    "https://github.com/fungi-computer/grove.git",
    "/scratch/grove",
  ]);
});
