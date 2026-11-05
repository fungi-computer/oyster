import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function effects(overrides: Partial<TryEffects> = {}) {
  const stop = vi.fn(() => Promise.resolve());
  const fake = {
    installDependencies: vi.fn(() => Promise.resolve()),
    startServer: vi.fn(() =>
      Promise.resolve({ stop, exited: new Promise<number | null>(vi.fn()) }),
    ),
    installHello: vi.fn(() => Promise.resolve(201)),
    installDesktop: vi.fn(() => Promise.resolve()),
    signInLink: vi.fn(() =>
      Promise.resolve({ url: "http://127.0.0.1:1/once", close: vi.fn() }),
    ),
    open: vi.fn(),
    interrupted: vi.fn(() => Promise.resolve()),
    portFree: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  } satisfies TryEffects;
  return { fake, stop };
}

describe("oyster try", () => {
  it("scaffolds once, then restarts the same Oyster with the same key", async () => {
    const directory = join(root, "my-oyster");
    const first = effects();
    await tryOyster([directory, "--no-open"], first.fake, plain().ui);

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
    expect(first.fake.startServer).toHaveBeenCalledWith({
      directory,
      port: 8787,
      key,
      verbose: false,
    });
    expect(first.fake.installHello).toHaveBeenCalledWith({
      directory,
      url: "http://127.0.0.1:8787",
      key,
    });
    expect(first.fake.open).not.toHaveBeenCalled();
    expect(first.stop).toHaveBeenCalledTimes(1);

    const second = effects();
    const output = plain();
    await tryOyster([directory, "--no-open"], second.fake, output.ui);
    expect(second.fake.installDependencies).not.toHaveBeenCalled();
    expect(second.fake.startServer).toHaveBeenCalledWith({
      directory,
      port: 8787,
      key,
      verbose: false,
    });
    expect((await readFile(keyPath, "utf8")).trim()).toBe(key);
    expect(output.text()).not.toContain(key);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it("restarts from inside the directory without naming it", async () => {
    const directory = join(root, "inside");
    await tryOyster([directory, "--no-open"], effects().fake, plain().ui);
    const again = effects();
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      await tryOyster(["--no-open"], again.fake, plain().ui);
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
    await expect(tryOyster([directory], fake, plain().ui)).rejects.toThrow(
      /already has files/u,
    );
    expect(fake.installDependencies).not.toHaveBeenCalled();
  });

  it("names a busy port and stops nothing it did not start", async () => {
    const { fake } = effects({ portFree: () => Promise.resolve(false) });
    await expect(
      tryOyster([join(root, "x"), "--port", "9000"], fake, plain().ui),
    ).rejects.toThrow(/Port 9000 .* already in use/u);
    expect(fake.startServer).not.toHaveBeenCalled();
  });

  it("stops the server when installing the Hello App fails", async () => {
    const { fake, stop } = effects({
      installHello: () => Promise.reject(new Error("nope")),
    });
    await expect(
      tryOyster([join(root, "y"), "--no-open"], fake, plain().ui),
    ).rejects.toThrow("nope");
    expect(stop).toHaveBeenCalledTimes(1);
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
    await tryOyster([directory, "--no-open"], effects().fake, output.ui);
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
      "Installing the Hello App",
      "Building Tourtois (about 2 min the first time)",
      "Opening your desktop",
      "Oyster is running",
      "Stopped.",
    ])
      expect(text).toContain(step);
    expect(text).toContain(join(directory, ".oyster-owner"));
  });

  it("asks for the install log and a clean directory when installing fails", async () => {
    const directory = join(root, "broken");
    const output = plain();
    const { fake } = effects({
      installDependencies: () =>
        Promise.reject(new Error("npm install failed (exit 1).")),
    });
    const failure = await tryOyster([directory], fake, output.ui).catch(
      (cause: unknown) => cause,
    );
    reportTryFailure(failure, output.ui);
    const text = output.text();
    expect(text).toContain("error: npm install failed (exit 1).");
    expect(text).toContain(join(directory, ".oyster", "install.log"));
    expect(text).toContain("delete " + directory);
    expect(fake.startServer).not.toHaveBeenCalled();
  });

  it("shows a busy port as a title and the exact command to retry", async () => {
    const output = plain();
    const failure = await tryOyster(
      [join(root, "p"), "--port", "9000"],
      effects({ portFree: () => Promise.resolve(false) }).fake,
      output.ui,
    ).catch((cause: unknown) => cause);
    reportTryFailure(failure, output.ui);
    expect(output.text()).toContain(
      "error: Port 9000 on 127.0.0.1 is already in use.\n  next: Stop whatever is using it, or choose another port: `npx @fungi.computer/oyster try --port 9001`.",
    );
  });

  it("names the Node upgrade when Node is too old", async () => {
    const real = process.versions.node;
    Object.defineProperty(process.versions, "node", {
      value: "22.1.0",
      configurable: true,
    });
    try {
      const output = plain();
      const failure = await tryOyster(
        [join(root, "n")],
        effects().fake,
        output.ui,
      ).catch((cause: unknown) => cause);
      reportTryFailure(failure, output.ui);
      expect(output.text()).toContain(
        "Oyster needs Node 24 or newer; this is Node 22.1.0.",
      );
      expect(output.text()).toContain("https://nodejs.org");
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
    await tryOyster([join(root, "z"), "--no-open"], fake, output.ui);
    const key = (
      await readFile(join(root, "z", ".oyster-owner"), "utf8")
    ).trim();
    const text = output.text();
    expect(text).toContain("http://127.0.0.1:1/once");
    expect(text).toContain("offline");
    expect(text).toContain("Continuing with the Hello App");
    expect(text).toContain("Owner key saved in:");
    expect(text.replace(key, "")).not.toContain("/once?");
    expect(fake.signInLink).toHaveBeenCalledWith({
      oysterUrl: "http://127.0.0.1:8787",
      key,
    });
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
      expect((await fetch(link.url)).status).toBe(404);
    } finally {
      link.close();
    }
  });
});
