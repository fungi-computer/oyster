import { describe, expect, it } from "vitest";
import {
  childInstallationAddress,
  childMatchesLaunch,
  sharedRead,
} from "../../src/page/child-selection.js";

const origin = "https://oyster.test";
const launch = {
  appId: "app_notes",
  releaseId: "rel_notes",
  surfaceId: "installation:notes",
  href: "/apps/notes/",
};
const config = {
  installationId: "notes",
  appId: "app_notes",
  releaseId: "rel_notes",
  computerId: "workspace",
};

describe("child selection", () => {
  it("asks only an installation page for its configuration", () => {
    expect(childInstallationAddress("/apps/notes/", origin)?.pathname).toBe(
      "/apps/notes/",
    );
    expect(
      childInstallationAddress(
        "/apps/notes/?computerId=A",
        origin,
      )?.searchParams.get("computerId"),
    ).toBe("A");
    for (const href of [
      "/api/workbench/directory",
      "/apps/notes",
      "/apps/notes/backend",
      "https://elsewhere.test/apps/notes/",
    ])
      expect(childInstallationAddress(href, origin)).toBeNull();
  });
  it("admits the configuration that still serves the launch", () => {
    expect(childMatchesLaunch(launch, "/apps/notes/", config, undefined)).toBe(
      true,
    );
    expect(
      childMatchesLaunch(launch, "/apps/notes/", config, "workspace"),
    ).toBe(true);
  });
  it("refuses a changed Release, App, address or Computer", () => {
    for (const [changedLaunch, pathname, changedConfig, computer] of [
      [launch, "/apps/notes/", { ...config, releaseId: "rel_next" }, undefined],
      [launch, "/apps/notes/", { ...config, appId: "app_other" }, undefined],
      [launch, "/apps/other/", config, undefined],
      [
        { ...launch, surfaceId: "installation:other" },
        "/apps/notes/",
        config,
        undefined,
      ],
      [
        launch,
        "/apps/notes/",
        { ...config, installationId: "other" },
        undefined,
      ],
      [launch, "/apps/notes/", config, "fleet-b"],
    ] as const)
      expect(
        childMatchesLaunch(changedLaunch, pathname, changedConfig, computer),
      ).toBe(false);
  });
  it("shares one read in flight and reads again once it settles", async () => {
    let reads = 0;
    const read = sharedRead(() => Promise.resolve(++reads));
    expect(await Promise.all([read(), read()])).toEqual([1, 1]);
    expect(await read()).toBe(2);
    const failing = sharedRead(() => Promise.reject(new Error("down")));
    await expect(failing()).rejects.toThrow("down");
    await expect(failing()).rejects.toThrow("down");
  });
});
