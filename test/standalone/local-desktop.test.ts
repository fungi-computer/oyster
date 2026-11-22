import { execFileSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  isOlderStarterRelease,
  localDesktopState,
  savedStarterIsOlder,
  starterCloneArguments,
  starterReleaseTag,
  starterTagCommits,
} from "../../src/standalone/local-desktop.js";
import { standaloneAppSet } from "../../src/standalone/app-set.js";
import { approvedInstallation } from "../../src/testing/installation.js";
import { declaration, release } from "../apps-fixture.js";

const input = { url: "http://127.0.0.1:8787", key: "test-owner" };
const warned = vi.fn<(message: string) => void>();
const checking = { ...input, warn: warned };
const installed = () =>
  approvedInstallation({
    declaration,
    release,
    installationId: "tourtois",
    instanceId: null,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  warned.mockClear();
});

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

const older = "a".repeat(40);
const newer = "c".repeat(40);

it("lists each release tag's commit, peeling annotated tags", () => {
  expect([
    ...starterTagCommits(
      [
        `${older}\trefs/tags/v0.18.2`,
        `1111111111111111111111111111111111111111\trefs/tags/v0.19.0`,
        `${newer}\trefs/tags/v0.19.0^{}`,
      ].join("\n"),
    ),
  ]).toEqual([
    ["v0.18.2", older],
    ["v0.19.0", newer],
  ]);
});

it("replaces only an untouched release from an older Oyster", () => {
  const commits = new Map([
    ["v0.18.2", older],
    ["v0.19.0", newer],
  ]);
  expect(isOlderStarterRelease(`git:${older}`, "v0.19.0", commits)).toBe(true);
  expect(isOlderStarterRelease(`git:${newer}`, "v0.19.0", commits)).toBe(false);
  // The owner's own edit is in no release tag.
  expect(
    isOlderStarterRelease(`git:${"d".repeat(40)}`, "v0.19.0", commits),
  ).toBe(false);
  // Without this Oyster's tag there is nothing to replace it with.
  expect(isOlderStarterRelease(`git:${older}`, "v9.9.9", commits)).toBe(false);
});

it("finds a saved desktop an older Oyster built, from the starter's own tags", async () => {
  const tag = await starterReleaseTag();
  const root = mkdtempSync(join(tmpdir(), "starter-tags-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("commit", "--quiet", "--allow-empty", "-m", "old");
    git("tag", "v0.0.1");
    const oldCommit = git("rev-parse", "HEAD");
    git("commit", "--quiet", "--allow-empty", "-m", "current");
    git("tag", tag);
    const currentCommit = git("rev-parse", "HEAD");
    const tourtois = standaloneAppSet.find(
      (app) => app.installationId === "tourtois",
    );
    if (tourtois === undefined) throw new Error("tourtois is a starter App");
    const saved = async (commit: string) => {
      const row = await installed();
      const revision = { sourceRevision: `git:${commit}` };
      return {
        ...row,
        release: {
          ...row.release,
          artifact: {
            ...row.release.artifact,
            provenance: { ...row.release.artifact.provenance, ...revision },
          },
        },
      };
    };
    const asked = async (commit: string) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json([await saved(commit)])),
      );
      return savedStarterIsOlder(tourtois, checking, root);
    };
    expect(await asked(oldCommit)).toBe(true);
    expect(await asked(currentCommit)).toBe(false);
    expect(await asked("b".repeat(40))).toBe(false);
    expect(warned).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const tourtoisApp = () => {
  const app = standaloneAppSet.find((one) => one.installationId === "tourtois");
  if (app === undefined) throw new Error("tourtois is a starter App");
  return app;
};
const answerWith = async (status: "enabled" | "disabled") => {
  const row = { ...(await installed()), status };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(Response.json([row])),
  );
};

it("keeps the saved App and says why when the release tags cannot be listed", async () => {
  await answerWith("enabled");
  const missing = join(tmpdir(), "no-such-starter-repository");
  expect(await savedStarterIsOlder(tourtoisApp(), checking, missing)).toBe(
    false,
  );
  expect(warned).toHaveBeenCalledTimes(1);
  expect(warned.mock.calls[0]?.[0]).toMatch(
    /^Couldn't check for a newer Tourtois: .+; keeping the saved one\.$/u,
  );
});

it("keeps the saved App and names the timeout when the tags are too slow", async () => {
  await answerWith("enabled");
  // A git server that accepts and never answers.
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  if (!(address instanceof Object)) throw new Error("expected a port");
  try {
    expect(
      await savedStarterIsOlder(
        tourtoisApp(),
        checking,
        `git://127.0.0.1:${String(address.port)}/slow.git`,
        1000,
      ),
    ).toBe(false);
    expect(warned).toHaveBeenCalledWith(
      "Couldn't check for a newer Tourtois: timed out after 1s; keeping the saved one.",
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
});

it("leaves a disabled install alone without listing any tags", async () => {
  await answerWith("disabled");
  const missing = join(tmpdir(), "no-such-starter-repository");
  expect(await savedStarterIsOlder(tourtoisApp(), checking, missing)).toBe(
    false,
  );
  expect(warned).not.toHaveBeenCalled();
});
