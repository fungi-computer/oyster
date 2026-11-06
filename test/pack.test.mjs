import assert from "node:assert/strict";
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { appBuildJsonSchema } from "@fungi.computer/puffball/app";
import { assetBuildJsonSchema } from "@fungi.computer/puffball/assets";
import { createServer } from "node:http";
import { URL } from "node:url";
import { installRelease, packRelease } from "../dist/pack.js";
import { approvedInstallation } from "../dist/testing/index.js";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import { instanceIds } from "../dist/instance-id.js";

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

test("installRelease uploads, submits once and awaits the correlated owner completion", async (t) => {
  const { options } = await fixture(t, undefined);
  const packed = await packRelease(options);
  const installation = await approvedInstallation({
    installationId: "fixture-app",
    instanceId: instanceIds.instance.generate(),
    release: packed.release,
    declaration: emptyAppDeclaration,
  });
  const requests = [];
  let operation;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body });
      if (request.url === "/api/installations") {
        operation = {
          state: "pending",
          requestId: request.headers["idempotency-key"],
          requestedInstallationId: "fixture-app",
          installationId: "fixture-app",
          release: packed.release,
        };
        response
          .writeHead(202, { "Content-Type": "application/json" })
          .end(JSON.stringify(operation));
      } else if (
        request.url.startsWith("/api/installations/fixture-app/status?")
      ) {
        assert.equal(
          new URL(request.url, "http://fixture.test").searchParams.get(
            "requestId",
          ),
          operation.requestId,
        );
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            ...operation,
            state: "succeeded",
            creation: "replacement",
            installation,
            reference: {
              generation: "fixture-generation",
              instanceId: installation.instanceId,
              authorityVersion: installation.authority.authorityVersion,
              status: installation.status,
            },
            uiCheck: { kind: "passed" },
          }),
        );
      } else if (request.url.startsWith("/api/artifacts/")) {
        response.writeHead(204).end();
      } else response.writeHead(200).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // Observe the maintained timer interface without replacing time or waiting
  // twenty minutes. An explicit installer budget must not be silently clamped.
  const timeout = t.mock.method(globalThis.AbortSignal, "timeout");
  const response = await installRelease({
    directory: options.outDirectory,
    url: `http://127.0.0.1:${String(server.address().port)}`,
    key: "owner-key",
    installationId: "fixture-app",
    waitMs: 20 * 60_000,
  });
  assert.equal(response.status, 200);
  const installs = requests.filter(
    (request) => !request.url.startsWith("/api/artifacts/"),
  );
  assert.equal(installs.length, 2);
  const [install] = installs;
  assert.equal(install.method, "POST");
  assert.equal(install.url, "/api/installations");
  const body = JSON.parse(install.body);
  assert.equal(body.installationId, "fixture-app");
  assert.equal(body.release.releaseId, packed.release.releaseId);
  assert.equal(installs[1].method, "GET");
  assert.deepEqual(await response.json(), installation);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments[0]),
    [20 * 60_000],
  );
});

test("an already cancelled pack leaves source and output untouched", async (t) => {
  const { options } = await fixture(t, undefined);
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(packRelease({ ...options, signal: controller.signal }), {
    name: "AbortError",
  });
  await assert.rejects(readFile(join(options.outDirectory, "release.json")), {
    code: "ENOENT",
  });
  assert.match(
    await readFile(join(options.sourceDirectory, "bundle/index.html"), "utf8"),
    /Committed/,
  );
});

for (const phase of ["upload", "admission", "observation"]) {
  test(`cancellation during ${phase} does not resubmit or claim an installation outcome`, async (t) => {
    const { options } = await fixture(t, undefined);
    const packed = await packRelease(options);
    const controller = new globalThis.AbortController();
    const requests = [];
    let requestId;
    let admitted = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests.push({ method: request.method, url: request.url });
        if (request.url.startsWith("/api/artifacts/")) {
          if (phase === "upload") controller.abort();
          else response.writeHead(204).end();
        } else if (request.method === "POST") {
          requestId = request.headers["idempotency-key"];
          if (phase === "admission") controller.abort();
          else
            response.writeHead(202, { "Content-Type": "application/json" }).end(
              JSON.stringify({
                state: "pending",
                requestId,
                requestedInstallationId: "fixture-app",
                installationId: "fixture-app",
                release: packed.release,
              }),
            );
        } else controller.abort();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const failure = await installRelease({
      directory: options.outDirectory,
      url: `http://127.0.0.1:${server.address().port}`,
      key: "fixture-owner",
      installationId: "fixture-app",
      signal: controller.signal,
      onAdmitted: () => {
        admitted += 1;
      },
    }).catch((cause) => cause);
    if (phase === "upload") {
      assert.equal(failure.name, "AbortError");
      assert.equal(
        requests.filter((request) => request.method === "POST").length,
        0,
      );
    } else {
      assert.match(failure.message, /Installation outcome unconfirmed/);
      assert.equal(failure.requestId, requestId);
      assert.equal(
        requests.filter((request) => request.method === "POST").length,
        1,
      );
      assert.equal(admitted, phase === "observation" ? 1 : 0);
    }
    assert.equal(
      await readFile(join(options.outDirectory, "release.json"), "utf8")
        .then(JSON.parse)
        .then((release) => release.releaseId),
      packed.release.releaseId,
    );
  });
}

test("cancellation during local artifact commit waits for all owned writes", async (t) => {
  const { options } = await fixture(t, undefined);
  const expected = await packRelease(options);
  await rm(options.outDirectory, { recursive: true, force: true });
  await mkdir(options.outDirectory);
  const controller = new globalThis.AbortController();
  let observedCommit = false;
  const watcher = watch(options.outDirectory, (_event, name) => {
    if (name === "artifacts") {
      observedCommit = true;
      controller.abort();
    }
  });
  try {
    await assert.rejects(
      packRelease({ ...options, signal: controller.signal }),
      { name: "AbortError" },
    );
    assert.equal(observedCommit, true);
    const artifacts = await readdir(join(options.outDirectory, "artifacts"), {
      recursive: true,
      withFileTypes: true,
    });
    const files = artifacts.filter((entry) => entry.isFile());
    assert.equal(files.length, expected.artifacts.length);
    for (const file of files)
      assert.ok(
        (await readFile(join(file.parentPath, file.name))).byteLength > 0,
      );
    await assert.rejects(readFile(join(options.outDirectory, "release.json")), {
      code: "ENOENT",
    });
  } finally {
    watcher.close();
  }
});
