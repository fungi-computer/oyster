import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import {
  normalizeAppPublisherRecipe,
  teamAppCandidateManifestSchema,
  workspaceBuildPolicy,
  type PinnedRecipe,
} from "@fungi.computer/oyster/build-contract";
import { privateTeamBuildSource } from "@fungi.computer/oyster/source";
import {
  buildTeamCandidate,
  teamCandidateLayout,
} from "../../src/build/candidate-builder.js";
import { releaseSchema } from "@fungi.computer/puffball/effect";
const exec = promisify(execFile);
it("builds exact committed edits with the recorded builder, independent of the live checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-candidate-"));
  try {
    const repository = join(root, "repository");
    await mkdir(join(repository, "bundle"), { recursive: true });
    await exec("git", ["init", "--initial-branch=main", repository]);
    const git = (args: string[]) => exec("git", ["-C", repository, ...args]);
    await git(["config", "user.name", "Publication fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repository, "bundle/index.html"), "<p>First edit</p>");
    await git(["add", "bundle/index.html"]);
    await git(["commit", "-m", "First edit"]);
    const first = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const pinned = normalizeAppPublisherRecipe({
      appId: "app_fork",
      recipe: {
        kind: "bundled-html",
        entry: "bundle/index.html",
        backend: null,
        assets: {
          maxManifestBytes: 4096,
          maxObjects: 8,
          maxObjectBytes: 4096,
          maxTotalBytes: 8192,
        },
        assetBase: "/",
        maxOutputBytes: 8192,
      },
    });
    const source = privateTeamBuildSource({
      appId: "app_fork",
      repository: "app_fork",
      templateSeed: { appId: "app_seed", revision: `git:${first}` },
      ...pinned,
    });
    expect(source.recipe.assetBase).toBe("./");
    expect(source.recipe.toolchain).toEqual(pinned.recipe.toolchain);
    await writeFile(
      join(repository, "bundle/index.html"),
      "<p>Second edit</p>",
    );
    await git(["add", "bundle/index.html"]);
    await git(["commit", "-m", "Second edit"]);
    const second = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      join(repository, "bundle/index.html"),
      "<p>Uncommitted content must not ship</p>",
    );
    const candidates = [];
    for (const [revision, expected] of [
      [first, "First edit"],
      [second, "Second edit"],
    ]) {
      if (!revision || !expected) throw new Error("Missing fixture revision");
      const outputPath = join(root, revision);
      const report = await buildTeamCandidate({
        configuration: {
          buildPolicy: workspaceBuildPolicy,
          appId: source.appId,
          recipe: source.recipe,
          buildRecipeDigest: source.buildRecipeDigest,
          sourceRevision: `git:${revision}`,
        },
        repositoryPath: repository,
        outputPath,
      });
      const layout = teamCandidateLayout(outputPath);
      const wire = await readFile(layout.manifest, "utf8");
      expect(report.bytes).toBe(Buffer.byteLength(wire));
      // The builder reports where its time went, phase by phase; this
      // bundled recipe installs nothing, so only its capture takes time.
      expect(
        Object.values(report.phases).every(
          (milliseconds) => Number.isFinite(milliseconds) && milliseconds >= 0,
        ),
      ).toBe(true);
      expect(report.phases.capture).toBeGreaterThan(0);
      const candidate = Schema.decodeUnknownSync(
        Schema.fromJsonString(teamAppCandidateManifestSchema),
      )(wire);
      expect(candidate.provenance.sourceRevision).toBe(`git:${revision}`);
      expect(candidate.provenance.buildRecipeDigest).toBe(
        source.buildRecipeDigest,
      );
      if (
        candidate.output.kind !== "ui" ||
        candidate.output.ui.content.kind !== "assets"
      )
        throw new Error("Expected UI assets");
      expect(candidate.output.ui.content.base).toBe("./");
      // The manifest names each object; its bytes are written beside it.
      const [asset] = candidate.output.ui.content.assets;
      if (asset === undefined) throw new Error("Expected one asset");
      const bytes = await readFile(layout.object(asset.digest));
      expect(bytes.byteLength).toBe(asset.byteLength);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        asset.digest,
      );
      expect(new TextDecoder().decode(bytes)).toContain(expected);
      candidates.push(candidate);
    }
    const reports: string[] = [];
    const uploads: string[] = [];
    const reportFailures: unknown[] = [];
    const receiveReport = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(
          Buffer.from(Schema.decodeUnknownSync(Schema.Uint8Array)(chunk)),
        );
      const body = Buffer.concat(chunks);
      const object = /^\/objects\/sha256-([0-9a-f]{64})$/u.exec(
        request.url ?? "",
      );
      if (object !== null) {
        // Each object alone, with its stated length, under its own digest.
        expect(request.method).toBe("PUT");
        expect(request.headers["x-team-app-build"]).toBe(
          "fixture-upload-grant",
        );
        expect(request.headers["content-length"]).toBe(String(body.byteLength));
        expect(createHash("sha256").update(body).digest("hex")).toBe(object[1]);
        uploads.push(object[1] ?? "");
        reports.push("/objects");
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/candidate") {
        const uploaded = Schema.decodeUnknownSync(
          Schema.fromJsonString(teamAppCandidateManifestSchema),
        )(body.toString("utf8"));
        // Every object the manifest names was uploaded before it.
        if (
          uploaded.output.kind !== "ui" ||
          uploaded.output.ui.content.kind !== "assets"
        )
          throw new Error("Expected UI assets");
        expect(uploads.sort()).toEqual(
          uploaded.output.ui.content.assets
            .map((asset) => asset.digest.slice("sha256:".length))
            .sort(),
        );
        expect(uploaded.provenance.sourceRevision).toBe(`git:${first}`);
        expect(request.headers["x-team-app-build"]).toBe(
          "fixture-upload-grant",
        );
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            kind: "submitted",
            release: {
              appId: uploaded.appId,
              releaseId: "rel_fixture",
              artifact: {
                artifactRef: "artifact:fixture",
                artifactDigest: `sha256:${"a".repeat(64)}`,
                provenance: uploaded.provenance,
              },
            },
          }),
        );
        reports.push(request.url);
        return;
      }
      reports.push(request.url ?? "");
      response.writeHead(204).end();
    };
    const reportServer = createServer((request, response) => {
      void receiveReport(request, response).catch((cause: unknown) => {
        reportFailures.push(cause);
        response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) =>
      reportServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = Schema.decodeUnknownSync(
        Schema.Struct({ port: Schema.Number }),
      )(reportServer.address());
      const configuration = Buffer.from(
        JSON.stringify({
          buildPolicy: workspaceBuildPolicy,
          appId: source.appId,
          recipe: source.recipe,
          buildRecipeDigest: source.buildRecipeDigest,
          sourceRevision: `git:${first}`,
          uploadGrant: "fixture-upload-grant",
        }),
      ).toString("base64");
      const executed = await exec(
        process.execPath,
        [
          new URL("../../dist/build/candidate-cli.mjs", import.meta.url)
            .pathname,
          configuration,
          repository,
          join(root, "cli-candidate"),
        ],
        {
          env: {
            PATH: process.env.PATH,
            TEAM_BUILD_REPORT: `http://127.0.0.1:${address.port.toString()}`,
          },
        },
      );
      expect(executed.stderr).toBe("");
      const recorded = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            bytes: Schema.Number,
            digest: Schema.String,
            release: releaseSchema,
          }),
        ),
      )(executed.stdout);
      expect(recorded.bytes).toBeGreaterThan(0);
      expect(recorded.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      if (reportFailures.length > 0)
        throw new AggregateError(
          reportFailures,
          "Candidate report fixture failed",
        );
      expect(reports).toEqual([
        "/objects",
        "/candidate",
        "/artifact",
        "/status",
      ]);
    } catch (cause) {
      throw new AggregateError(
        [...reportFailures, cause],
        "Candidate builder proof failed",
        { cause },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        reportServer.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    expect(candidates[0]?.provenance.sourceTreeDigest).not.toBe(
      candidates[1]?.provenance.sourceTreeDigest,
    );
    await expect(
      buildTeamCandidate({
        configuration: {
          buildPolicy: workspaceBuildPolicy,
          appId: source.appId,
          recipe: source.recipe,
          buildRecipeDigest: `sha256:${"0".repeat(64)}`,
          sourceRevision: `git:${first}`,
        },
        repositoryPath: repository,
        outputPath: join(root, "bad"),
      }),
    ).rejects.toMatchObject({ code: "invalid_recipe" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The request a host encodes into the fixed build command. */
type BuilderRequest = Readonly<{
  buildPolicy?: string;
  appId: string;
  sourceRevision: string;
  recipe: PinnedRecipe;
  buildRecipeDigest: string;
  uploadGrant: string;
}>;

/** Run the Computer builder CLI on one encoded request against a committed
 * one-page repository; answers its exit and whether it built a candidate. */
async function runCli(request: (revision: string) => BuilderRequest) {
  const root = await mkdtemp(join(tmpdir(), "team-candidate-cli-"));
  try {
    const repository = join(root, "repository");
    await mkdir(join(repository, "bundle"), { recursive: true });
    await exec("git", ["init", "--initial-branch=main", repository]);
    const git = (args: string[]) => exec("git", ["-C", repository, ...args]);
    await writeFile(join(repository, "bundle/index.html"), "<p>Page</p>");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "page",
    ]);
    const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const candidate = join(root, "candidate");
    // No report URL: a build that gets past its request still exits 1, but
    // only after writing its candidate.
    const outcome = await exec(
      process.execPath,
      [
        new URL("../../dist/build/candidate-cli.mjs", import.meta.url).pathname,
        Buffer.from(JSON.stringify(request(revision))).toString("base64url"),
        repository,
        candidate,
      ],
      { env: { PATH: process.env.PATH } },
    ).then(
      () => ({ exitCode: 0, stderr: "" }),
      (error: unknown) => {
        const failed = Schema.decodeUnknownSync(
          Schema.Struct({ code: Schema.Number, stderr: Schema.String }),
        )(error);
        return { exitCode: failed.code, stderr: failed.stderr };
      },
    );
    const built = await readFile(teamCandidateLayout(candidate).manifest).then(
      () => true,
      () => false,
    );
    return { ...outcome, built };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("refuses a request whose build policy is not this builder's", async () => {
  const { recipe, buildRecipeDigest } = normalizeAppPublisherRecipe({
    appId: "app_fork",
    recipe: {
      kind: "bundled-html",
      entry: "bundle/index.html",
      backend: null,
      assets: {
        maxManifestBytes: 4096,
        maxObjects: 8,
        maxObjectBytes: 4096,
        maxTotalBytes: 8192,
      },
      assetBase: "./",
      maxOutputBytes: 8192,
    },
  });
  const request = (revision: string) => ({
    appId: "app_fork",
    sourceRevision: `git:${revision}`,
    recipe,
    buildRecipeDigest,
    uploadGrant: "fixture-upload-grant",
  });
  // This builder's own policy builds the candidate.
  expect(
    await runCli((revision) => ({
      ...request(revision),
      buildPolicy: workspaceBuildPolicy,
    })),
  ).toMatchObject({ exitCode: 1, built: true });
  // Missing or superseded policy metadata builds nothing.
  const refused = await runCli(request);
  expect(refused).toMatchObject({ exitCode: 1, built: false });
  expect(refused.stderr).toContain("Team App source/build failed");
  expect(refused.stderr).toContain("buildPolicy");
  expect(
    await runCli((revision) => ({
      ...request(revision),
      buildPolicy: "package-json-fungi-build-v2",
    })),
  ).toMatchObject({ exitCode: 1, built: false });
}, 60_000);
