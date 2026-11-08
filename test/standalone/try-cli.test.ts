import {
  existsSync,
  watch,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectManager,
  reportTryFailure,
  tryOyster,
  type TryEffects,
} from "../../src/standalone/try-cli.js";
import { CleanupError } from "../../src/build/process-group.js";
import { InstallationObservationError } from "../../src/installation-client.js";
import { startSignInLink } from "../../src/standalone/sign-in-link.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oyster-try-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
      mkdirSync(join(directory, "node_modules/wrangler/bin"), {
        recursive: true,
      });
      writeFileSync(
        join(directory, "node_modules/wrangler/bin/wrangler.js"),
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
        if (app.installationId === "shed") stopTrial();
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
    expect(text).toContain(
      "shed installed: needs a Computer runtime (see shed)",
    );
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
    mkdirSync(join(directory, "node_modules/wrangler/bin"), {
      recursive: true,
    });
    writeFileSync(
      join(directory, "node_modules/wrangler/bin/wrangler.js"),
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
      const failure = await tryOyster(
        [directory, "--port", String(address.port), "--no-open"],
        undefined,
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
