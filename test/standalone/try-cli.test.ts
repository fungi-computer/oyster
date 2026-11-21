import {
  existsSync,
  watch,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Buffer } from "node:buffer";
import { encode as encodeBase64Url } from "effect/encoding/Base64Url";
import * as native from "wrangler";
import { createCredentialSealer } from "@fungi.computer/veil/credential-store";
import { PassThrough } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectManager,
  installTryDependencies,
  reportTryFailure,
  tryOyster,
  prepareTryModelKeyCustody,
  type TrialKeychain,
  type TryEffects,
} from "../../src/standalone/try-cli.js";
import { CleanupError } from "../../src/build/process-group.js";
import { InstallationObservationError } from "../../src/installation-client.js";
import { startSignInLink } from "../../src/standalone/sign-in-link.js";

let root: string;
let home: string;
beforeEach(() => {
  const scratch = fileURLToPath(new URL("../../.botanical/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "oyster-try-test-"));
  home = mkdtempSync(join(scratch, "oyster-try-home-"));
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A piped terminal: plain lines, the same as CI. */
function plain() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const ui = new Cli({ brand: "fungi", output: stream, interactive: false });
  return { ui, text: () => chunks.join("") };
}

const cancellations = new WeakMap<TryEffects, AbortController>();

function runTry(args: readonly string[], fake: TryEffects, ui: Cli) {
  return tryOyster(args, fake, ui, cancellations.get(fake)?.signal);
}

function effects(overrides: Partial<TryEffects> = {}) {
  const controller = new AbortController();
  const stop = vi.fn(() => Promise.resolve());
  const fake = {
    installDependencies: vi.fn((directory: string) => {
      mkdirSync(
        join(directory, "node_modules/@fungi.computer/oyster/dist/standalone"),
        {
          recursive: true,
        },
      );
      writeFileSync(
        join(
          directory,
          "node_modules/@fungi.computer/oyster/dist/standalone/try-worker.js",
        ),
        "",
      );
      return Promise.resolve(undefined);
    }),
    startServer: vi.fn(() =>
      Promise.resolve({ stop, exited: new Promise<number | null>(vi.fn()) }),
    ),
    installHello: vi.fn(() => Promise.resolve(201)),
    installDesktop: vi.fn(() => Promise.resolve("ready" as const)),
    installStarter: vi.fn(() => Promise.resolve("installed" as const)),
    reportStarters: vi.fn(() => Promise.resolve()),
    takeRetries: vi.fn((): Promise<readonly string[]> => Promise.resolve([])),
    startComputer: vi.fn(() =>
      Promise.resolve({ stop: vi.fn(() => Promise.resolve()) }),
    ),
    modelSetup: vi.fn(() => Promise.resolve("ready" as const)),
    signInLink: vi.fn(() => {
      setImmediate(() => {
        controller.abort();
      });
      return Promise.resolve({
        url: "http://127.0.0.1:1/once",
        close: vi.fn(() => Promise.resolve()),
      });
    }),
    open: vi.fn(),
    portFree: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  } satisfies TryEffects;
  cancellations.set(fake, controller);
  return { fake, stop, controller };
}

describe("oyster try", () => {
  it("shares one private package store across the desktop and starter builds of each trial", async () => {
    const stores: string[] = [];
    for (const name of ["first", "second"]) {
      const directory = join(root, name);
      const received: string[] = [];
      const fixture = effects({
        installDesktop: (input) => {
          received.push(input.packageStoreDirectory);
          return Promise.resolve("ready" as const);
        },
        installStarter: (_app, input) => {
          received.push(input.packageStoreDirectory);
          return Promise.resolve("installed" as const);
        },
      });
      await runTry([directory, "--no-open"], fixture.fake, plain().ui);
      const store = join(directory, ".oyster", "package-store");
      expect(received).toEqual(Array<string>(7).fill(store));
      stores.push(store);
    }
    expect(stores[0]).not.toBe(stores[1]);
  });

  it("keeps at most two starter builds in flight and fills a freed slot", async () => {
    const permits = new Map(
      ["grove", "prints", "inkcap", "trellis", "bonsai", "shed"].map(
        (id) => [id, Promise.withResolvers<"installed">()] as const,
      ),
    );
    const first = Promise.withResolvers<undefined>();
    const third = Promise.withResolvers<undefined>();
    const complete = Promise.withResolvers<undefined>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    let finished = 0;
    const fixture = effects({
      signInLink: () =>
        Promise.resolve({
          url: "http://127.0.0.1:1/once",
          close: () => Promise.resolve(),
        }),
      installStarter: async (app) => {
        started.push(app.installationId);
        active += 1;
        peak = Math.max(peak, active);
        if (started.length === 1) first.resolve(undefined);
        if (started.length === 3) third.resolve(undefined);
        const permit = permits.get(app.installationId);
        if (permit === undefined) throw new Error("Unexpected starter App");
        const result = await permit.promise;
        active -= 1;
        if (++finished === 6) complete.resolve(undefined);
        return result;
      },
    });
    const running = runTry(
      [join(root, "slots"), "--no-open"],
      fixture.fake,
      plain().ui,
    );
    try {
      await first.promise;
      await new Promise<void>((done) => setImmediate(done));
      expect(started).toEqual(["grove", "prints"]);
      permits.get("grove")?.resolve("installed");
      await third.promise;
      expect(started).toEqual(["grove", "prints", "inkcap"]);
      expect(active).toBe(2);
    } finally {
      for (const permit of permits.values()) permit.resolve("installed");
      await complete.promise;
      await new Promise<void>((done) => setImmediate(done));
      fixture.controller.abort();
      await running;
    }
    expect(peak).toBe(2);
  });

  it("publishes concurrent starter progress in order without overlapping writes", async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let calls = 0;
    let active = 0;
    let peak = 0;
    const fixture = effects({
      signInLink: () =>
        Promise.resolve({
          url: "http://127.0.0.1:1/once",
          close: () => Promise.resolve(),
        }),
      reportStarters: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (++calls === 2) {
          entered.resolve(undefined);
          await release.promise;
        }
        active -= 1;
      },
    });
    const running = runTry(
      [join(root, "reports"), "--no-open"],
      fixture.fake,
      plain().ui,
    );
    try {
      await entered.promise;
      await new Promise<void>((done) => setImmediate(done));
      expect(peak).toBe(1);
    } finally {
      release.resolve(undefined);
      await new Promise<void>((done) => setImmediate(done));
      fixture.controller.abort();
      await running;
    }
    expect(peak).toBe(1);
  });

  it("starts one Computer and stops it before the Oyster server", async () => {
    const stopped: string[] = [];
    const fixture = effects({
      startComputer: vi.fn(() =>
        Promise.resolve({
          stop: () => {
            stopped.push("computer");
            return Promise.resolve();
          },
        }),
      ),
      startServer: vi.fn(() =>
        Promise.resolve({
          stop: () => {
            stopped.push("server");
            return Promise.resolve();
          },
          exited: new Promise<number | null>(() => undefined),
        }),
      ),
    });
    await runTry(
      [join(root, "computer"), "--no-open"],
      fixture.fake,
      plain().ui,
    );
    expect(fixture.fake.startComputer).toHaveBeenCalledOnce();
    expect(stopped).toEqual(["computer", "server"]);
  });

  it("keeps Oyster usable and explains a refused sandbox startup", async () => {
    const fixture = effects({
      startComputer: vi.fn(() =>
        Promise.reject(new Error("Workspace sandbox unavailable")),
      ),
    });
    const output = plain();
    await runTry(
      [join(root, "no-runtime"), "--no-open"],
      fixture.fake,
      output.ui,
    );
    expect(output.text()).toContain(
      "The Computer runtime is unavailable (Workspace sandbox unavailable)",
    );
    expect(fixture.fake.installDesktop).toHaveBeenCalledOnce();
    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  it("prepares Hello and Tourtois together before offering sign-in", async () => {
    const entered = Promise.withResolvers<undefined>();
    const hello = Promise.withResolvers<number>();
    const desktop = Promise.withResolvers<"ready">();
    const fixture = effects({
      installHello: () => {
        entered.resolve(undefined);
        return hello.promise;
      },
      installDesktop: vi.fn(() => desktop.promise),
    });
    const running = runTry([join(root, "parallel")], fixture.fake, plain().ui);
    try {
      await entered.promise;
      expect(fixture.fake.installDesktop).toHaveBeenCalledOnce();
      expect(fixture.fake.signInLink).not.toHaveBeenCalled();
      hello.resolve(201);
      await hello.promise;
      expect(fixture.fake.signInLink).not.toHaveBeenCalled();
    } finally {
      hello.resolve(201);
      desktop.resolve("ready");
      await running;
    }
  });

  it("installs the workspace tarballs a proof names through npm overrides", async () => {
    const directory = join(root, "overridden");
    const tarballs = join(root, "tarballs");
    mkdirSync(tarballs);
    for (const name of ["oyster.tgz", "computer.tgz", "agar.tgz"])
      writeFileSync(join(tarballs, name), "");
    const map = join(tarballs, "overrides.json");
    writeFileSync(
      map,
      JSON.stringify({
        "@fungi.computer/oyster": join(tarballs, "oyster.tgz"),
        "@fungi.computer/computer": join(tarballs, "computer.tgz"),
        "@fungi.computer/agar": join(tarballs, "agar.tgz"),
      }),
    );
    vi.stubEnv("OYSTER_TRY_OVERRIDES", map);
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()),
        overrides: z.record(z.string(), z.string()),
      })
      .parse(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      );
    const spec = (name: string) => `file:${join(tarballs, name)}`;
    expect(manifest.overrides).toEqual({
      "@fungi.computer/oyster": spec("oyster.tgz"),
      "@fungi.computer/computer": spec("computer.tgz"),
      "@fungi.computer/agar": spec("agar.tgz"),
    });
    // npm refuses an override that disagrees with a direct dependency.
    expect(manifest.dependencies["@fungi.computer/oyster"]).toBe(
      spec("oyster.tgz"),
    );
    expect(manifest.dependencies["@fungi.computer/computer"]).toBe(
      spec("computer.tgz"),
    );
  });

  it("gives a pnpm trial the same tarballs through its workspace overrides", async () => {
    const directory = join(root, "pnpm-overridden");
    const tarballs = join(root, "pnpm-tarballs");
    mkdirSync(tarballs);
    const map = join(tarballs, "overrides.json");
    const agar = join(tarballs, "agar.tgz");
    writeFileSync(agar, "");
    writeFileSync(map, JSON.stringify({ "@fungi.computer/agar": agar }));
    vi.stubEnv("OYSTER_TRY_OVERRIDES", map);
    vi.stubEnv("npm_config_user_agent", "pnpm/11.1.0 npm/? node/v24.20.0");
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    const workspace = await readFile(
      join(directory, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(workspace).toContain("allowBuilds:");
    expect(workspace.trimEnd().split("\n").at(-1)).toBe(
      `overrides: ${JSON.stringify({ "@fungi.computer/agar": `file:${agar}` })}`,
    );
  });

  it("refuses a tarball map naming a missing tarball or a non-tarball", async () => {
    const tarballs = join(root, "bad-tarballs");
    mkdirSync(tarballs);
    const map = join(tarballs, "overrides.json");
    const missing = join(tarballs, "agar.tgz");
    writeFileSync(map, JSON.stringify({ "@fungi.computer/agar": missing }));
    vi.stubEnv("OYSTER_TRY_OVERRIDES", map);
    await expect(
      runTry([join(root, "missing"), "--no-open"], effects().fake, plain().ui),
    ).rejects.toThrow(`Override tarball ${missing} does not exist`);
    const notTarball = join(tarballs, "agar.json");
    writeFileSync(notTarball, "{}");
    writeFileSync(map, JSON.stringify({ "@fungi.computer/agar": notTarball }));
    await expect(
      runTry([join(root, "json"), "--no-open"], effects().fake, plain().ui),
    ).rejects.toThrow("an absolute .tgz path");
  });

  it("writes no overrides without a proof's tarball map", async () => {
    const directory = join(root, "plain");
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    expect(
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    ).not.toHaveProperty("overrides");
  });

  it("scaffolds once, then restarts the same Oyster with the same key", async () => {
    const directory = join(root, "my-oyster");
    const first = effects();
    await runTry([directory, "--no-open"], first.fake, plain().ui);

    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      );
    expect(Object.keys(manifest.dependencies)).toEqual(
      expect.arrayContaining([
        "@fungi.computer/oyster",
        "@fungi.computer/computer",
        "@fungi.computer/truffle",
        "react",
        "react-dom",
        "wrangler",
      ]),
    );
    await expect(
      readFile(join(directory, "worker.ts"), "utf8"),
    ).resolves.toContain("@fungi.computer/oyster");
    await expect(
      readFile(join(directory, "wrangler.jsonc"), "utf8"),
    ).resolves.toContain("worker.ts");
    const keyPath = join(directory, ".oyster-owner");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const key = (await readFile(keyPath, "utf8")).trim();
    expect(key).toMatch(/^[0-9a-f]{48}$/u);
    expect(first.fake.installDependencies).toHaveBeenCalledTimes(1);
    expect(first.fake.startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        directory,
        port: 8787,
        key,
        verbose: false,
      }),
    );
    expect(first.fake.installHello).toHaveBeenCalledWith(
      expect.objectContaining({
        directory,
        url: "http://127.0.0.1:8787",
        key,
      }),
    );
    expect(first.fake.open).not.toHaveBeenCalled();
    expect(first.stop).toHaveBeenCalledTimes(1);

    const second = effects();
    const output = plain();
    await runTry([directory, "--no-open"], second.fake, output.ui);
    expect(second.fake.installDependencies).not.toHaveBeenCalled();
    expect(second.fake.startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        directory,
        port: 8787,
        key,
        verbose: false,
      }),
    );
    expect((await readFile(keyPath, "utf8")).trim()).toBe(key);
    expect(output.text()).not.toContain(key);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it("upgrades an older trial before starting while preserving owner and app source", async () => {
    const directory = join(root, "upgrade");
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    const key = await readFile(join(directory, ".oyster-owner"), "utf8");
    const manifest = await readFile(join(directory, "package.json"), "utf8");
    const worker = await readFile(join(directory, "worker.ts"), "utf8");
    const config = await readFile(join(directory, "wrangler.jsonc"), "utf8");
    writeFileSync(
      join(directory, "package.json"),
      '{"dependencies":{"@fungi.computer/oyster":"0.17.0"}}',
    );
    writeFileSync(join(directory, "worker.ts"), "// older generated worker");
    writeFileSync(join(directory, "wrangler.jsonc"), "{}");
    mkdirSync(join(directory, "hello-app"));
    writeFileSync(join(directory, "hello-app", "user.ts"), "// my edits");
    const next = effects({
      startServer: vi.fn(async () => {
        expect(await readFile(join(directory, "package.json"), "utf8")).toBe(
          manifest,
        );
        expect(await readFile(join(directory, "worker.ts"), "utf8")).toBe(
          worker,
        );
        expect(await readFile(join(directory, "wrangler.jsonc"), "utf8")).toBe(
          config,
        );
        return {
          stop: () => Promise.resolve(),
          exited: new Promise<number | null>(() => undefined),
        };
      }),
    });
    await runTry([directory, "--no-open"], next.fake, plain().ui);
    expect(next.fake.installDependencies).toHaveBeenCalledOnce();
    expect(await readFile(join(directory, ".oyster-owner"), "utf8")).toBe(key);
    expect(
      await readFile(join(directory, "hello-app", "user.ts"), "utf8"),
    ).toBe("// my edits");
    const unchanged = effects();
    await runTry([directory, "--no-open"], unchanged.fake, plain().ui);
    expect(unchanged.fake.installDependencies).not.toHaveBeenCalled();
  });

  it("resets local data seeded for another origin and says so plainly", async () => {
    const directory = join(root, "older");
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    // Data an older `try` seeded for https://oyster.test has no origin marker.
    await rm(join(directory, ".oyster", "origin"));
    mkdirSync(join(directory, ".wrangler", "state"), { recursive: true });
    const output = plain();
    await runTry([directory, "--no-open"], effects().fake, output.ui);
    expect(output.text()).toContain(
      "local data was made for https://oyster.test, so it was reset for http://127.0.0.1:8787",
    );
    expect(existsSync(join(directory, ".wrangler", "state"))).toBe(false);
    const quiet = plain();
    mkdirSync(join(directory, ".wrangler", "state"), { recursive: true });
    await runTry([directory, "--no-open"], effects().fake, quiet.ui);
    expect(quiet.text()).not.toContain("was reset");
    expect(existsSync(join(directory, ".wrangler", "state"))).toBe(true);
  });

  it("restarts from inside the directory without naming it", async () => {
    const directory = join(root, "inside");
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    const again = effects();
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      await runTry(["--no-open"], again.fake, plain().ui);
    } finally {
      vi.restoreAllMocks();
    }
    expect(again.fake.installDependencies).not.toHaveBeenCalled();
    expect(again.fake.startServer).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-empty directory it did not create", async () => {
    const directory = join(root, "busy");
    mkdirSync(directory);
    writeFileSync(join(directory, "notes.txt"), "mine");
    const { fake } = effects();
    await expect(runTry([directory], fake, plain().ui)).rejects.toThrow(
      /already has files/u,
    );
    expect(fake.installDependencies).not.toHaveBeenCalled();
  });

  it("names a busy port and stops nothing it did not start", async () => {
    const { fake } = effects({ portFree: () => Promise.resolve(false) });
    await expect(
      runTry([join(root, "x"), "--port", "9000"], fake, plain().ui),
    ).rejects.toThrow(/Port 9000 .* already in use/u);
    expect(fake.startServer).not.toHaveBeenCalled();
  });

  it.each(["approval-required", "disabled", "unavailable", "deleted"] as const)(
    "offers recovery for an existing %s desktop without claiming it was built",
    async (state) => {
      const output = plain();
      const { fake } = effects({
        installDesktop: () => Promise.resolve(state),
      });
      await runTry([join(root, state), "--no-open"], fake, output.ui);
      expect(output.text()).toContain("Oyster needs desktop repair");
      expect(output.text()).toContain("Preparing recovery sign-in");
      if (state === "deleted") {
        expect(output.text()).toContain("Tourtois was removed");
        expect(output.text()).toContain("/apps/hello/");
        expect(output.text()).not.toContain(
          "/api/installations/tourtois/grants",
        );
      } else
        expect(output.text()).toContain("/api/installations/tourtois/grants");
      expect(output.text()).not.toContain("Oyster is running");
      expect(output.text()).not.toContain("could not be built");
      expect(fake.open).not.toHaveBeenCalled();
    },
  );

  it("retains sign-in and the running Oyster when browser launching fails", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const output = plain();
      const { fake } = effects({
        open: (_url, failed) => {
          failed();
        },
      });
      await runTry([join(root, "browser")], fake, output.ui);
      expect(output.text()).toContain("The browser did not open");
      expect(output.text()).toContain("http://127.0.0.1:1/once");
      expect(output.text()).toContain("Oyster is running");
    } finally {
      if (descriptor === undefined)
        Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", descriptor);
    }
  });

  it("cancels both App preparations and refuses sign-in after server death", async () => {
    const exit = Promise.withResolvers<number | null>();
    const helloEntered = Promise.withResolvers<undefined>();
    const desktopEntered = Promise.withResolvers<undefined>();
    const cleaned: string[] = [];
    const waitForExit = async (name: string, signal: AbortSignal) => {
      await new Promise<void>((done) => {
        signal.addEventListener(
          "abort",
          () => {
            done();
          },
          { once: true },
        );
      });
      cleaned.push(name);
      signal.throwIfAborted();
    };
    const output = plain();
    const stop = vi.fn(() => Promise.resolve());
    const { fake } = effects({
      startServer: () => Promise.resolve({ stop, exited: exit.promise }),
      installHello: async ({ signal }) => {
        helloEntered.resolve(undefined);
        await waitForExit("hello", signal);
        return 201;
      },
      installDesktop: async ({ signal }) => {
        desktopEntered.resolve(undefined);
        await waitForExit("desktop", signal);
        return "ready";
      },
    });
    const running = runTry([join(root, "dead")], fake, output.ui);
    const rejected = expect(running).rejects.toThrow(
      "Oyster stopped unexpectedly during setup",
    );
    await Promise.all([helloEntered.promise, desktopEntered.promise]);
    exit.resolve(1);
    await rejected;
    expect(cleaned.sort()).toEqual(["desktop", "hello"]);
    expect(fake.signInLink).not.toHaveBeenCalled();
    expect(output.text()).not.toContain("Oyster is running");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("builds the other starter Apps after the desktop, one line each, and keeps going past a failure", async () => {
    const output = plain();
    const installed: string[] = [];
    let stopTrial = () => undefined;
    const fixture = effects({
      signInLink: vi.fn(() =>
        Promise.resolve({
          url: "http://127.0.0.1:1/once",
          close: vi.fn(() => Promise.resolve()),
        }),
      ),
      installStarter: vi.fn((app: { installationId: string }) => {
        installed.push(app.installationId);
        if (app.installationId === "trellis")
          return Promise.reject(new Error("build exploded"));
        if (app.installationId === "shed") setTimeout(stopTrial, 100);
        return Promise.resolve(
          app.installationId === "prints"
            ? ("already-installed" as const)
            : ("installed" as const),
        );
      }),
    });
    stopTrial = () => {
      fixture.controller.abort();
    };
    await runTry(
      [join(root, "starters"), "--no-open"],
      fixture.fake,
      output.ui,
    );
    expect(installed).toEqual([
      "grove",
      "prints",
      "inkcap",
      "trellis",
      "bonsai",
      "shed",
    ]);
    const text = output.text();
    expect(text).toContain("grove ready");
    expect(text).toContain("prints already installed");
    expect(text).toContain("trellis couldn't be installed: build exploded");
    expect(text).toContain("bonsai ready");
    expect(text).toContain("shed ready");
  });

  it("tells the desktop each App's state and retries a failed App when asked", async () => {
    const attempts: string[] = [];
    let stopTrial = () => undefined;
    let asked = false;
    const fixture = effects({
      signInLink: vi.fn(() =>
        Promise.resolve({
          url: "http://127.0.0.1:1/once",
          close: vi.fn(() => Promise.resolve()),
        }),
      ),
      installStarter: vi.fn((app: { installationId: string }) => {
        attempts.push(app.installationId);
        if (app.installationId === "trellis" && attempts.length < 7)
          return Promise.reject(new Error("build exploded"));
        if (attempts.length === 7) setTimeout(stopTrial, 100);
        return Promise.resolve("installed" as const);
      }),
      takeRetries: vi.fn(() => {
        const ids = asked ? [] : ["trellis"];
        asked = true;
        return Promise.resolve(ids);
      }),
    });
    stopTrial = () => {
      fixture.controller.abort();
    };
    await runTry([join(root, "retry"), "--no-open"], fixture.fake, plain().ui);
    expect(attempts).toEqual([
      "grove",
      "prints",
      "inkcap",
      "trellis",
      "bonsai",
      "shed",
      "trellis",
    ]);
    const reports = vi
      .mocked(fixture.fake.reportStarters)
      .mock.calls.map(([, list]) =>
        list.map((entry) => `${entry.installationId}:${entry.state}`),
      );
    expect(reports[0]).toEqual([
      "grove:installing",
      "prints:installing",
      "inkcap:installing",
      "trellis:installing",
      "bonsai:installing",
      "shed:installing",
    ]);
    expect(reports.some((list) => list.includes("trellis:failed"))).toBe(true);
    expect(reports.at(-1)).toEqual([]);
    const failed = vi
      .mocked(fixture.fake.reportStarters)
      .mock.calls.flatMap(([, list]) => list)
      .find((entry) => entry.state === "failed");
    expect(failed?.reason).toEqual({
      code: "build_failed",
      message: "build exploded",
    });
  }, 15_000);
  it("says what to do when no model is connected, and stays quiet when one is", async () => {
    const missing = plain();
    await runTry(
      [join(root, "no-model"), "--no-open"],
      effects({ modelSetup: vi.fn(() => Promise.resolve("missing" as const)) })
        .fake,
      missing.ui,
    );
    expect(missing.text()).toContain("No model is connected yet");
    expect(missing.text()).toContain("Keys, then Model keys");
    expect(missing.text()).toContain(
      "docs.fungi.computer/models/your-own-key/",
    );
    const ready = plain();
    await runTry(
      [join(root, "has-model"), "--no-open"],
      effects().fake,
      ready.ui,
    );
    expect(ready.text()).not.toContain("No model is connected");
  });

  it("installs no other starter App when the desktop is not ready", async () => {
    const fixture = effects({
      installDesktop: vi.fn(() =>
        Promise.resolve("approval-required" as const),
      ),
    });
    await runTry([join(root, "nodesk"), "--no-open"], fixture.fake, plain().ui);
    expect(fixture.fake.installStarter).not.toHaveBeenCalled();
  });

  it("stops the server when installing the Hello App fails", async () => {
    const { fake, stop } = effects({
      installHello: () => Promise.reject(new Error("nope")),
    });
    await expect(
      runTry([join(root, "y"), "--no-open"], fake, plain().ui),
    ).rejects.toThrow("nope");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not announce success when Hello installation is refused", async () => {
    const output = plain();
    const { fake, stop } = effects({
      installHello: () => Promise.resolve(403),
    });
    await expect(
      runTry([join(root, "refused"), "--port", "19001"], fake, output.ui),
    ).rejects.toThrow("HTTP 403");
    expect(fake.installDesktop).toHaveBeenCalledOnce();
    expect(output.text()).not.toContain("Oyster is running");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("uses pnpm only when pnpm ran the command", () => {
    expect(detectManager("pnpm/11.24.0 npm/? node/v24")).toBe("pnpm");
    expect(detectManager("npm/11.0.0 node/v24")).toBe("npm");
    expect(detectManager(undefined)).toBe("npm");
  });
});

describe("oyster try output", () => {
  it("prints plain steps and a success box with no escapes or key", async () => {
    const output = plain();
    const directory = join(root, "plain");
    await runTry([directory, "--no-open"], effects().fake, output.ui);
    const key = (
      await readFile(join(directory, ".oyster-owner"), "utf8")
    ).trim();
    const text = output.text();
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain(key);
    for (const step of [
      "Creating plain",
      "Installing dependencies with",
      "Starting Oyster",
      "Installing Hello and building Tourtois",
      "Preparing desktop sign-in",
      "Oyster is running",
      "Stopped.",
    ])
      expect(text).toContain(step);
    expect(text).toContain(join(directory, ".oyster-owner"));
  });

  it("keeps an interrupted dependency install rerunnable without losing source", async () => {
    const directory = join(root, "broken");
    const output = plain();
    const { fake } = effects({
      installDependencies: () =>
        Promise.reject(new Error("npm install failed (exit 1).")),
    });
    const failure = await runTry([directory], fake, output.ui).catch(
      (cause: unknown) => cause,
    );
    reportTryFailure(failure, output.ui);
    const text = output.text();
    expect(text).toContain("error: npm install failed (exit 1).");
    expect(text).toContain(join(directory, ".oyster", "install.log"));
    expect(text).not.toContain("delete ");
    const key = await readFile(join(directory, ".oyster-owner"), "utf8");
    writeFileSync(join(directory, "my-notes.txt"), "keep me");
    mkdirSync(
      join(directory, "node_modules/@fungi.computer/oyster/dist/standalone"),
      {
        recursive: true,
      },
    );
    writeFileSync(
      join(
        directory,
        "node_modules/@fungi.computer/oyster/dist/standalone/try-worker.js",
      ),
      "partial install",
    );
    const retry = effects();
    await runTry([directory, "--no-open"], retry.fake, plain().ui);
    expect(retry.fake.installDependencies).toHaveBeenCalledOnce();
    expect(await readFile(join(directory, ".oyster-owner"), "utf8")).toBe(key);
    expect(await readFile(join(directory, "my-notes.txt"), "utf8")).toBe(
      "keep me",
    );
    expect(fake.startServer).not.toHaveBeenCalled();
  });

  it("shows a busy port as a title and the exact command to retry", async () => {
    const output = plain();
    const failure = await runTry(
      [join(root, "p"), "--port", "9000"],
      effects({ portFree: () => Promise.resolve(false) }).fake,
      output.ui,
    ).catch((cause: unknown) => cause);
    reportTryFailure(failure, output.ui);
    expect(output.text()).toContain(
      "error: Port 9000 on 127.0.0.1 is already in use.",
    );
    expect(output.text()).toContain(
      `npx @fungi.computer/oyster try '${join(root, "p")}' --port 9001`,
    );
  });

  it("explains a real npm registry refusal and retains a retryable project", async () => {
    const directory = join(root, "registry-refused");
    mkdirSync(directory);
    writeFileSync(join(directory, ".oyster-owner"), "retained-owner");
    writeFileSync(join(directory, "notes.txt"), "keep me");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@fungi.computer/oyster": "0.13.0" },
      }),
    );
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = z.object({ port: z.number() }).parse(listener.address());
    await new Promise<void>((done, fail) =>
      listener.close((error) => {
        if (error) fail(error);
        else done();
      }),
    );
    vi.stubEnv(
      "npm_config_registry",
      `http://127.0.0.1:${String(address.port)}`,
    );
    vi.stubEnv("npm_config_cache", join(root, "npm-cache"));
    vi.stubEnv("npm_config_userconfig", join(root, ".npmrc"));
    vi.stubEnv("npm_config_fetch_retries", "0");
    try {
      const output = plain();
      const fixture = effects({
        installDependencies: async (project, manager, verbose, signal) => {
          // Source manifests carry workspace:*; npm receives resolved versions
          // in the published package. Exercise its real network failure with
          // the smallest published dependency, after the CLI refreshes files.
          writeFileSync(
            join(project, "package.json"),
            JSON.stringify({
              private: true,
              dependencies: { "@fungi.computer/oyster": "0.13.0" },
            }),
          );
          await installTryDependencies(project, manager, verbose, signal);
        },
      });
      const failure = await runTry(
        [directory, "--port", String(address.port), "--no-open"],
        fixture.fake,
        output.ui,
      ).catch((cause: unknown) => cause);
      reportTryFailure(failure, output.ui);
      expect(output.text()).toContain(
        "npm could not reach its package registry (ECONNREFUSED).",
      );
      expect(output.text()).toContain(
        "Check your connection and npm registry/proxy settings",
      );
      expect(output.text()).toContain(
        `npx @fungi.computer/oyster try '${directory}' --port ${String(address.port)} --no-open`,
      );
      expect(output.text()).toContain("your key and files stay in place");
      expect(await readFile(join(directory, ".oyster-owner"), "utf8")).toBe(
        "retained-owner",
      );
      expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe(
        "keep me",
      );
      expect(await readdir(join(directory, ".oyster"))).toContain(
        "install.pending",
      );
      expect(
        await readFile(join(directory, ".oyster/install.log"), "utf8"),
      ).toContain("ECONNREFUSED");
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("HOME", home);
    }
  });

  it("reports elapsed phases and clears its heartbeat on success and failure", async () => {
    vi.useFakeTimers();
    try {
      const output = plain();
      const fake = effects({
        installHello: async () => {
          await vi.advanceTimersByTimeAsync(5100);
          throw new Error("packing refused");
        },
      });
      await expect(
        runTry([join(root, "clock"), "--port", "12345"], fake.fake, output.ui),
      ).rejects.toThrow("packing refused");
      expect(output.text()).toContain(
        "Installing Hello and building Tourtois · 5.0s elapsed",
      );
      expect(output.text()).toContain(
        "Installing Hello and building Tourtois · failed after 5.1s",
      );
      expect(output.text()).toContain("Stopping Oyster · done in");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a valid alternate port at the upper bound and quotes project paths", async () => {
    const output = plain();
    const failure = await runTry(
      [
        join(root, "owner's project"),
        "--port",
        "65535",
        "--no-open",
        "--package",
        "/tmp/owner's candidate.tgz",
      ],
      effects({ portFree: () => Promise.resolve(false) }).fake,
      output.ui,
    ).catch((cause: unknown) => cause);
    reportTryFailure(failure, output.ui);
    expect(output.text()).toContain(
      "--port 8787 --no-open --package '/tmp/owner'\"'\"'s candidate.tgz'",
    );
    expect(output.text()).not.toContain("--port 65536");
    expect(output.text()).toContain("owner'\"'\"'s project");
  });

  it("names the Node upgrade when Node is too old", async () => {
    const real = process.versions.node;
    Object.defineProperty(process.versions, "node", {
      value: "22.1.0",
      configurable: true,
    });
    try {
      const output = plain();
      const failure = await runTry(
        [join(root, "n"), "--port", "19009", "--no-open"],
        effects().fake,
        output.ui,
      ).catch((cause: unknown) => cause);
      reportTryFailure(failure, output.ui);
      expect(output.text()).toContain(
        "Oyster needs Node 24 or newer; this is Node 22.1.0.",
      );
      expect(output.text()).toContain("https://nodejs.org");
      expect(output.text()).toContain(
        `${join(root, "n")}' --port 19009 --no-open`,
      );
    } finally {
      Object.defineProperty(process.versions, "node", {
        value: real,
        configurable: true,
      });
    }
  });

  it("explains an unknown option rather than printing a stack", () => {
    const output = plain();
    reportTryFailure(new Error("Unknown option '--nope'"), output.ui);
    expect(output.text()).toContain("error: Unknown option '--nope'");
    expect(output.text()).toContain("--verbose");
  });
});

describe("oyster try sign-in", () => {
  it("prints a link without the key and survives a desktop failure", async () => {
    const { fake } = effects({
      installDesktop: () => Promise.reject(new Error("offline")),
    });
    const output = plain();
    await runTry([join(root, "z"), "--no-open"], fake, output.ui);
    const key = (
      await readFile(join(root, "z", ".oyster-owner"), "utf8")
    ).trim();
    const text = output.text();
    expect(text).toContain("http://127.0.0.1:1/once");
    expect(text).toContain("offline");
    expect(text).toContain("Oyster needs desktop repair");
    expect(text).not.toContain("Oyster is running");
    expect(text).not.toContain("Preparing desktop sign-in");
    expect(text).toContain("Owner key saved in:");
    expect(text.replace(key, "")).not.toContain("/once?");
    expect(fake.signInLink).toHaveBeenCalledWith(
      expect.objectContaining({
        oysterUrl: "http://127.0.0.1:8787",
        key,
      }),
    );
  });

  it("serves its sign-in page once, posting the key rather than putting it in the URL", async () => {
    const link = await startSignInLink({
      oysterUrl: "http://127.0.0.1:8787",
      key: "k".repeat(48),
    });
    try {
      expect(link.url).not.toContain("kkkk");
      const first = await fetch(link.url);
      expect(first.status).toBe(200);
      const html = await first.text();
      expect(html).toContain('action="http://127.0.0.1:8787/login"');
      expect(html).toContain("k".repeat(48));
      const reused = await fetch(link.url, { redirect: "manual" });
      expect(reused.status).toBe(302);
      expect(reused.headers.get("Location")).toBe(
        "http://127.0.0.1:8787/login?link=used",
      );
    } finally {
      await link.close();
    }
  });
});

describe("startup cancellation ownership", () => {
  it.each(["hello", "desktop"])(
    "keeps the unconfirmed installation receipt when cancelling %s",
    async (phase) => {
      const interrupted = () => {
        fixture.controller.abort();
        return Promise.reject(
          new InstallationObservationError(`${phase}-receipt`),
        );
      };
      const fixture = effects(
        phase === "hello"
          ? { installHello: interrupted }
          : { installDesktop: interrupted },
      );
      const output = plain();
      await runTry([join(root, "receipt")], fixture.fake, output.ui);
      expect(output.text()).toContain(
        `Installation outcome unconfirmed (${phase}-receipt)`,
      );
      expect(output.text().match(/Stopped\./gu)).toHaveLength(1);
      expect(fixture.fake.signInLink).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "joins cancelled desktop cleanup after Hello fails (cleanup failure: %s)",
    async (cleanupFailure) => {
      const entered = Promise.withResolvers<undefined>();
      const aborted = Promise.withResolvers<undefined>();
      const released = Promise.withResolvers<undefined>();
      const fixture = effects({
        installHello: async () => {
          await entered.promise;
          throw new Error("Hello refused");
        },
        installDesktop: async ({ signal }) => {
          const cancelled = new Promise<void>((done) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve(undefined);
                done();
              },
              { once: true },
            );
          });
          entered.resolve(undefined);
          await cancelled;
          await released.promise;
          if (cleanupFailure)
            throw new CleanupError("Desktop scratch cleanup failed");
          signal.throwIfAborted();
          return "ready";
        },
      });
      const output = plain();
      const running = runTry(
        [join(root, "failed-hello")],
        fixture.fake,
        output.ui,
      );
      const rejected = expect(running).rejects.toThrow(
        cleanupFailure ? "Desktop scratch cleanup failed" : "Hello refused",
      );
      await aborted.promise;
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(fixture.fake.signInLink).not.toHaveBeenCalled();
      released.resolve(undefined);
      await rejected;
      expect(fixture.stop).toHaveBeenCalledOnce();
      expect(output.text()).not.toContain("Stopped.");
      expect(output.text()).not.toContain("Oyster is running");
    },
  );

  it("waits for desktop cleanup when interrupted after Hello has settled", async () => {
    const entered = Promise.withResolvers<undefined>();
    const released = Promise.withResolvers<undefined>();
    const fixture = effects({
      installDesktop: async ({ signal }) => {
        entered.resolve(undefined);
        await released.promise;
        signal.throwIfAborted();
        return "ready";
      },
    });
    const output = plain();
    const running = runTry(
      [join(root, "cancel-apps")],
      fixture.fake,
      output.ui,
    );
    await entered.promise;
    fixture.controller.abort();
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(output.text()).not.toContain("Stopped.");
    released.resolve(undefined);
    await running;
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.fake.signInLink).not.toHaveBeenCalled();
    expect(output.text().match(/Stopped\./gu)).toHaveLength(1);
  });

  it.each([false, true])(
    "cancels fresh scaffolding before its key is published (empty target: %s)",
    async (emptyTarget) => {
      const directory = join(root, "fresh");
      if (emptyTarget) mkdirSync(directory);
      const fixture = effects();
      let observedBeforeKey = false;
      const watcher = watch(root, { encoding: "utf8" }, (_event, name) => {
        if (!name?.startsWith(".oyster-try-")) return;
        const stage = join(root, name);
        if (existsSync(stage) && !existsSync(join(stage, ".oyster-owner"))) {
          observedBeforeKey = true;
          fixture.controller.abort();
        }
      });
      try {
        await runTry([directory, "--no-open"], fixture.fake, plain().ui);
        expect(observedBeforeKey).toBe(true);
        expect(fixture.fake.installDependencies).not.toHaveBeenCalled();
        expect(await readdir(root)).toEqual(emptyTarget ? ["fresh"] : []);
        if (emptyTarget) expect(await readdir(directory)).toEqual([]);
      } finally {
        watcher.close();
      }
    },
  );

  it("awaits dependency cleanup, preserves resumable files, and prints one exact retry", async () => {
    const directory = join(root, "owner's project");
    const output = plain();
    const entered = Promise.withResolvers<undefined>();
    const released = Promise.withResolvers<undefined>();
    const fixture = effects({
      installDependencies: async (_directory, _manager, _verbose, signal) => {
        entered.resolve(undefined);
        await released.promise;
        signal.throwIfAborted();
      },
    });
    const listeners = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    const running = runTry(
      [
        directory,
        "--port",
        "19011",
        "--no-open",
        "--package",
        "file:/candidate's oyster.tgz",
      ],
      fixture.fake,
      output.ui,
    );
    await entered.promise;
    const key = await readFile(join(directory, ".oyster-owner"), "utf8");
    writeFileSync(join(directory, "notes.txt"), "keep this");
    fixture.controller.abort();
    expect(output.text()).not.toContain("Stopped.");
    released.resolve(undefined);
    await running;
    expect(output.text().match(/Stopped\./gu)).toHaveLength(1);
    expect(output.text()).toContain(
      "--port 19011 --no-open --package 'file:/candidate'\"'\"'s oyster.tgz'",
    );
    expect(output.text()).not.toContain("Oyster is running");
    expect(fixture.fake.startServer).not.toHaveBeenCalled();
    expect(await readFile(join(directory, ".oyster-owner"), "utf8")).toBe(key);
    expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe(
      "keep this",
    );
    expect(await readdir(join(directory, ".oyster"))).toContain(
      "install.pending",
    );
    expect(await readdir(root)).toEqual(["owner's project"]);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(listeners);
    await runTry([directory, "--no-open"], effects().fake, plain().ui);
    expect(await readFile(join(directory, ".oyster-owner"), "utf8")).toBe(key);
  });

  it("adopts a server returned during cancellation before reporting stopped", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const fixture = effects({
      startServer: () => {
        fixture.controller.abort();
        return Promise.resolve({
          stop,
          exited: new Promise<number | null>(() => undefined),
        });
      },
    });
    const output = plain();
    await runTry([join(root, "acquired")], fixture.fake, output.ui);
    expect(stop).toHaveBeenCalledOnce();
    expect(fixture.fake.installHello).not.toHaveBeenCalled();
    expect(output.text()).toContain("Stopped.");
  });

  it("attempts every cleanup and restores listeners without claiming a clean stop when one fails", async () => {
    const closing = vi.fn(() => Promise.reject(new Error("close failed")));
    const fixture = effects({
      signInLink: () => {
        fixture.controller.abort();
        return Promise.resolve({
          url: "http://127.0.0.1:1/once",
          close: closing,
        });
      },
    });
    const output = plain();
    const listeners = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    await expect(
      runTry([join(root, "failed-cleanup")], fixture.fake, output.ui),
    ).rejects.toThrow("cleanup did not complete");
    expect(closing).toHaveBeenCalledOnce();
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(output.text()).not.toContain("Stopped.");
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(listeners);
  });

  it.each([false, true])(
    "preserves compiler cleanup failure (cancelled: %s)",
    async (cancelled) => {
      const fixture = effects({
        installDesktop: () => {
          if (cancelled) fixture.controller.abort();
          return Promise.reject(
            new CleanupError("Local compiler cleanup failed"),
          );
        },
      });
      const output = plain();
      await expect(
        runTry([join(root, "compiler-cleanup")], fixture.fake, output.ui),
      ).rejects.toThrow("Local compiler cleanup failed");
      expect(fixture.stop).toHaveBeenCalledOnce();
      expect(fixture.fake.signInLink).not.toHaveBeenCalled();
      expect(output.text()).not.toContain("Stopped.");
    },
  );

  it("awaits the actual one-time listener close and allows repeated close", async () => {
    const controller = new AbortController();
    const link = await startSignInLink({
      oysterUrl: "http://127.0.0.1:8787",
      key: "fixture-owner",
      signal: controller.signal,
    });
    controller.abort();
    await link.close();
    await link.close();
    await expect(fetch(link.url)).rejects.toThrow();
  });
});

describe("trial model-key custody", () => {
  const configuredKey = encodeBase64Url(new Uint8Array(32).fill(7));
  const otherKey = encodeBase64Url(new Uint8Array(32).fill(9));
  // A faithful in-memory keychain behind the same port the OS keychain fills.
  const keychain = { values: new Map<string, string>(), locked: false };
  const osKeychain: TrialKeychain = (account) => {
    if (keychain.locked)
      return Promise.reject(new Error("synthetic locked keychain"));
    return Promise.resolve({
      getPassword: () => Promise.resolve(keychain.values.get(account) ?? null),
      setPassword: (value: string) => {
        keychain.values.set(account, value);
        return Promise.resolve();
      },
    });
  };
  const headless: TrialKeychain = () => Promise.resolve(undefined);
  beforeEach(() => {
    keychain.values.clear();
    keychain.locked = false;
  });

  it("keeps the wrapping key in one 0600 fallback file on headless Linux and warns once", async () => {
    project();
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const first = await prepareTryModelKeyCustody(root, headless);
      const second = await prepareTryModelKeyCustody(root, headless);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ activeKeyId: "local" });
      expect(bindings().OYSTER_CREDENTIAL_KEY).toBeUndefined();
      const messages = warning.mock.calls
        .map(([text]) => String(text))
        .filter((text) =>
          text.includes("Linux Secret Service is not available"),
        );
      expect(messages).toHaveLength(1);
      const files = await readdir(
        join(home, ".config", "fungi", "oyster-trials"),
      );
      const trial = files[0];
      if (trial === undefined) throw new Error("Missing private trial");
      const fallback = join(
        home,
        ".config",
        "fungi",
        "oyster-trials",
        trial,
        "credential-keyring.json",
      );
      expect(statSync(fallback).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(fallback, "utf8"))).toEqual(first);
    } finally {
      warning.mockRestore();
      vi.unstubAllEnvs();
      vi.stubEnv("HOME", home);
    }
  });

  // A headless server or CI runner with a systemd user session has a session
  // bus but no Secret Service; its trial must start on the 0600 file.
  it.runIf(process.platform === "linux")(
    "uses the 0600 file when the session bus offers no Secret Service",
    async () => {
      project();
      const bus = await privateSessionBus();
      const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", bus.address);
        vi.stubEnv("DISPLAY", undefined);
        const first = await prepareTryModelKeyCustody(root);
        expect(first).toMatchObject({ activeKeyId: "local" });
        expect(await prepareTryModelKeyCustody(root)).toEqual(first);
        const notice = warning.mock.calls
          .map(([text]) => String(text))
          .find((text) =>
            text.includes("Linux Secret Service is not available"),
          );
        expect(notice).toContain("UNENCRYPTED in the 0600 file");
        expect(notice).toContain("credential-keyring.json");
        expect(notice).toContain("install and start a Secret Service provider");
      } finally {
        warning.mockRestore();
        bus.stop();
      }
    },
  );

  /** A dbus-daemon with no service directories: nothing can be activated. */
  async function privateSessionBus() {
    // A short socket directory: a checkout path can exceed sun_path's limit.
    const sockets = mkdtempSync(join(tmpdir(), "oyster-bus-"));
    const config = join(root, "session-bus.conf");
    writeFileSync(
      config,
      `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${sockets}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
    );
    const daemon = spawn(
      "dbus-daemon",
      [`--config-file=${config}`, "--nofork", "--print-address=1"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    // A missing dbus-daemon (ENOENT) or a daemon that never prints its
    // address fails this proof at once instead of hanging the suite.
    const [line] = z.tuple([z.string()]).parse(
      await Promise.race([
        once(createInterface({ input: daemon.stdout }), "line", {
          signal: AbortSignal.timeout(10_000),
        }),
        once(daemon, "error").then(([cause]: unknown[]) => {
          throw new Error(
            "This Linux proof needs dbus-daemon (the dbus package) on PATH",
            { cause },
          );
        }),
      ]),
    );
    return {
      address: line.trim(),
      stop: () => {
        daemon.kill();
        rmSync(sockets, { recursive: true, force: true });
      },
    };
  }

  function project() {
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(root, "wrangler.jsonc"),
      '{"name":"custody-proof","compatibility_date":"2026-09-04","vars":{"PUBLIC":"public value"}}\n',
    );
    writeFileSync(join(root, ".oyster-owner"), "fixture-owner");
  }

  function bindings() {
    const config = native.unstable_readConfig({
      config: join(root, "wrangler.jsonc"),
    });
    return native.unstable_getVarsForDev(
      config.userConfigPath,
      undefined,
      config.vars,
      undefined,
      true,
      config.secrets,
    );
  }

  it("keeps a separate master key in the OS keychain across trial restarts", async () => {
    project();
    const first = await prepareTryModelKeyCustody(root, osKeychain);
    expect(
      first.keys[first.activeKeyId] ===
        (await readFile(join(root, ".oyster-owner"), "utf8")).trim(),
    ).toBe(false);
    const envelope = await createCredentialSealer(first, "restart-proof").seal(
      [],
      "model-token-fixture",
    );
    const restarted = await prepareTryModelKeyCustody(root, osKeychain);
    expect(restarted).toEqual(first);
    expect(keychain.values.size).toBe(1);
    expect(bindings().OYSTER_CREDENTIAL_KEY).toBeUndefined();
    expect(existsSync(join(root, ".env.local"))).toBe(false);
    expect(
      await createCredentialSealer(restarted, "restart-proof").open(
        [],
        envelope,
      ),
    ).toBe("model-token-fixture");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(
      "/.env.local",
    );
  });

  it.each([".dev.vars", ".env", ".env.local"])(
    "moves a configured key from %s into private custody without changing other native bindings",
    async (file) => {
      project();
      if (file === ".dev.vars")
        writeFileSync(
          join(root, ".env.local"),
          `OYSTER_CREDENTIAL_KEY=${otherKey}\n`,
        );
      const before = `# existing local settings\nOYSTER_CREDENTIAL_KEY="${configuredKey}"\nOTHER_SECRET='unchanged value'\n`;
      writeFileSync(join(root, file), before);
      const migrated = await prepareTryModelKeyCustody(root, osKeychain);
      expect(migrated.keys[migrated.activeKeyId]).toBe(configuredKey);
      expect(migrated.keys.instance).toBe(configuredKey);
      expect(await readFile(join(root, file), "utf8")).not.toContain(
        configuredKey,
      );
      expect(bindings().OYSTER_CREDENTIAL_KEY).toBeUndefined();
      expect(await prepareTryModelKeyCustody(root, osKeychain)).toEqual(
        migrated,
      );
      expect(bindings().OTHER_SECRET).toEqual({
        type: "secret_text",
        value: "unchanged value",
      });
      expect(bindings().PUBLIC).toEqual({
        type: "plain_text",
        value: "public value",
      });
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      const ignore = await readFile(join(root, ".gitignore"), "utf8");
      expect(ignore).toContain("/.dev.vars");
      expect(ignore).toContain("/.env\n");
    },
  );

  it("does not append its wrapping key to an existing native vars file", async () => {
    project();
    const before = "# literal native secret\nOTHER_SECRET='literal $VALUE'\n";
    writeFileSync(join(root, ".dev.vars"), before);
    await prepareTryModelKeyCustody(root, osKeychain);
    expect(
      (await readFile(join(root, ".dev.vars"), "utf8")).startsWith(before),
    ).toBe(true);
    expect(bindings().OTHER_SECRET).toEqual({
      type: "secret_text",
      value: "literal $VALUE",
    });
    expect(bindings().OYSTER_CREDENTIAL_KEY).toBeUndefined();
  });

  it("refuses an invalid existing key without replacement or secret-bearing errors", async () => {
    project();
    const before = "OYSTER_CREDENTIAL_KEY=invalid-private-fixture\n";
    writeFileSync(join(root, ".dev.vars"), before);
    const failure: unknown = await prepareTryModelKeyCustody(
      root,
      osKeychain,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    const output = plain();
    reportTryFailure(failure, output.ui);
    expect(output.text()).toContain(
      "This Oyster could not prepare private model-key storage.",
    );
    expect(output.text()).not.toContain("invalid-private-fixture");
    expect((await readFile(join(root, ".dev.vars"), "utf8")) === before).toBe(
      true,
    );
  });

  it("does not depend on dotenv loading to retain a new key", async () => {
    project();
    vi.stubEnv("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "false");
    try {
      const first = await prepareTryModelKeyCustody(root, osKeychain);
      expect(await prepareTryModelKeyCustody(root, osKeychain)).toEqual(first);
      expect(existsSync(join(root, ".env.local"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("HOME", home);
    }
  });

  it("refuses a locked keychain instead of silently downgrading custody", async () => {
    project();
    keychain.locked = true;
    const failure: unknown = await prepareTryModelKeyCustody(
      root,
      osKeychain,
    ).catch((cause: unknown) => cause);
    const output = plain();
    reportTryFailure(failure, output.ui);
    // The underlying keychain error is the reason the person sees.
    expect(output.text()).toContain(
      "could not prepare private model-key storage. Reason: synthetic locked keychain",
    );
    expect(keychain.values.size).toBe(0);
    expect(bindings().OYSTER_CREDENTIAL_KEY).toBeUndefined();
  });

  it("refuses to replace an old key hidden by disabled native dotenv loading", async () => {
    project();
    const before = `OYSTER_CREDENTIAL_KEY=${configuredKey}\n`;
    writeFileSync(join(root, ".env.local"), before);
    vi.stubEnv("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "false");
    await expect(prepareTryModelKeyCustody(root, osKeychain)).rejects.toThrow(
      "could not prepare private model-key storage",
    );
    expect(await readFile(join(root, ".env.local"), "utf8")).toBe(before);
    expect(keychain.values.size).toBe(0);
  });
});
