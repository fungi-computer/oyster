import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { appBuildJsonSchema } from "@fungi.computer/puffball/app";
import { assetBuildJsonSchema } from "@fungi.computer/puffball/assets";
import { createServer } from "node:http";
import { installRelease, packRelease } from "../dist/pack.js";

const assets = {
  maxManifestBytes: 65_536,
  maxObjects: 16,
  maxObjectBytes: 65_536,
  maxTotalBytes: 131_072,
};

async function fixture(t, app) {
  const directory = await mkdtemp(join(tmpdir(), "oyster-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Pack proof",
      "-c",
      "user.email=pack@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    return `git:${git("rev-parse", "HEAD")}`;
  };
  git("init", "--quiet");
  await writeFile(join(directory, ".gitignore"), "release/\n");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ fungi: { app } }),
  );
  await mkdir(join(directory, "bundle"));
  await writeFile(
    join(directory, "bundle/index.html"),
    "<!doctype html><title>Committed</title>",
  );
  return {
    commit,
    options: {
      appId: "app_fixture",
      sourceDirectory: directory,
      sourceRevision: commit(),
      recipe: {
        kind: "bundled-html",
        entry: "bundle/index.html",
        assets,
        assetBase: "./",
        backend: null,
        maxOutputBytes: assets.maxTotalBytes,
      },
      outDirectory: join(directory, "release"),
    },
  };
}

async function rootOf(options) {
  const packed = await packRelease(options);
  const read = async (ref) => {
    const artifact = packed.artifacts.find(
      ({ artifactRef }) => artifactRef === ref,
    );
    assert.ok(artifact);
    return readFile(artifact.path, "utf8");
  };
  return {
    packed,
    read,
    root: Schema.decodeUnknownSync(appBuildJsonSchema)(
      await read(packed.release.artifact.artifactRef),
    ),
  };
}

test("UI-only committed packing retains capabilities and commands in the Release", async (t) => {
  const declaration = {
    capabilities: ["computer.readFile"],
    handlers: [],
    roles: [],
    commands: [{ id: "open", title: "Open", category: "File" }],
  };
  const { options } = await fixture(t, declaration);
  const { root, packed } = await rootOf(options);
  assert.deepEqual(root.declaration, declaration);
  assert.equal(root.ui.mediaType, "application/vnd.fungi.app-assets+json");
  assert.equal(
    packed.release.artifact.provenance.sourceRevision,
    options.sourceRevision,
  );
});

test("package capabilities receive canonical defaults without a backend", async (t) => {
  const { options } = await fixture(t, { capabilities: ["computer.readFile"] });
  const { root } = await rootOf(options);
  assert.deepEqual(root.declaration, {
    capabilities: ["computer.readFile"],
    handlers: [],
    roles: [],
  });
});

test("handwritten API methods are refused by the canonical declaration emitter", async (t) => {
  const { options } = await fixture(t, {
    capabilities: [],
    handlers: [],
    roles: [],
    api: {
      methods: {
        read: {
          description: "Read",
          input: { type: "object" },
          output: { type: "object" },
          effect: "read",
          requires: [],
        },
      },
    },
  });
  await assert.rejects(rootOf(options));
});

test("the requested commit supplies bytes and declaration, excluding dirty files and later commits", async (t) => {
  const { options, commit } = await fixture(t, {
    capabilities: ["computer.readFile"],
  });
  await writeFile(
    join(options.sourceDirectory, "bundle/index.html"),
    "<!doctype html><title>Changed</title>",
  );
  await writeFile(
    join(options.sourceDirectory, "package.json"),
    JSON.stringify({
      fungi: { app: { capabilities: ["computer.writeFile"] } },
    }),
  );
  const first = await rootOf(options);
  assert.deepEqual(first.root.declaration.capabilities, ["computer.readFile"]);
  const manifest = Schema.decodeUnknownSync(assetBuildJsonSchema)(
    await first.read(first.root.ui.artifactRef),
  );
  const html = manifest.assets.find((asset) => asset.path === "/index.html");
  assert.ok(html);
  assert.equal(
    await first.read(html.artifactRef),
    "<!doctype html><title>Committed</title>",
  );
  const nextRevision = commit();
  const old = await rootOf(options);
  assert.equal(
    old.packed.release.artifact.provenance.sourceRevision,
    options.sourceRevision,
  );
  assert.deepEqual(old.root.declaration.capabilities, ["computer.readFile"]);
  const next = await rootOf({ ...options, sourceRevision: nextRevision });
  assert.equal(
    next.packed.release.artifact.provenance.sourceRevision,
    nextRevision,
  );
  assert.deepEqual(next.root.declaration.capabilities, ["computer.writeFile"]);
  assert.notEqual(
    next.packed.release.artifact.provenance.sourceTreeDigest,
    first.packed.release.artifact.provenance.sourceTreeDigest,
  );
});

test("invalid committed declarations fail instead of creating an undeclared Release", async (t) => {
  const { options, commit } = await fixture(t, {
    capabilities: ["not.a.capability"],
  });
  await assert.rejects(rootOf(options));
  await writeFile(join(options.sourceDirectory, "package.json"), "{broken");
  await assert.rejects(rootOf({ ...options, sourceRevision: commit() }));
});

test("sources without package declarations still pack with no declaration", async (t) => {
  const { options, commit } = await fixture(t, undefined);
  assert.equal((await rootOf(options)).root.declaration, undefined);
  await rm(join(options.sourceDirectory, "package.json"));
  assert.equal(
    (await rootOf({ ...options, sourceRevision: commit() })).root.declaration,
    undefined,
  );
});

test("canonical recipe bounds reject oversized assets", async (t) => {
  const { options } = await fixture(t, undefined);
  await assert.rejects(
    rootOf({
      ...options,
      recipe: { ...options.recipe, assets: { ...assets, maxObjectBytes: 8 } },
    }),
  );
});

test("installRelease uploads artifacts, then one install-or-select POST names the installation", async (t) => {
  const { options } = await fixture(t, undefined);
  const packed = await packRelease(options);
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body });
      if (request.url === "/api/installations") {
        // The host's install-or-select switches an existing installation.
        response.writeHead(200).end("{}");
      } else if (request.url.startsWith("/api/artifacts/")) {
        response.writeHead(204).end();
      } else response.writeHead(200).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await installRelease({
    directory: options.outDirectory,
    url: `http://127.0.0.1:${String(server.address().port)}`,
    key: "owner-key",
    installationId: "fixture app",
  });
  assert.equal(response.status, 200);
  const installs = requests.filter(
    (request) => !request.url.startsWith("/api/artifacts/"),
  );
  assert.equal(installs.length, 1);
  const [install] = installs;
  assert.equal(install.method, "POST");
  assert.equal(install.url, "/api/installations");
  const body = JSON.parse(install.body);
  assert.equal(body.installationId, "fixture app");
  assert.equal(body.release.releaseId, packed.release.releaseId);
});
