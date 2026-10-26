import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import { approvedInstallation } from "../src/testing/installation.js";
import { installationRequestIdSchema } from "../src/installation-operations.js";
import { instanceIds } from "../src/instance-id.js";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "src/standalone/install-apps-bin.ts");
const key = "fixture-cli-owner-key-24-characters";
const release = {
  appId: "app_cli",
  releaseId: "rel_cli",
  artifact: {
    artifactRef: "artifact:ui",
    artifactDigest: "sha256:" + "b".repeat(64),
    provenance: {
      sourceRevision: "git:" + "a".repeat(40),
      sourceTreeDigest: "sha256:" + "c".repeat(64),
      buildRecipeDigest: "sha256:" + "d".repeat(64),
    },
  },
};

/** The owner's settled answer to the CLI's status read. */
type Outcome =
  | Readonly<{ state: "succeeded"; available: boolean }>
  | Readonly<{ state: "refused"; status: number; code: string }>;

async function fixture(
  uploadStatus = 201,
  outcome: Outcome = { state: "succeeded", available: true },
) {
  const decoded = Schema.decodeUnknownSync(releaseSchema)(release);
  const installation = await approvedInstallation({
    release: decoded,
    declaration: emptyAppDeclaration,
    installationId: "cli-demo",
    instanceId: instanceIds.instance.generate(),
  });
  let requestId: string | undefined;
  const directory = await mkdtemp(join(tmpdir(), "oyster-install-cli-"));
  await mkdir(join(directory, "artifacts"));
  await writeFile(join(directory, "artifacts/ui"), "fixture-ui");
  await writeFile(join(directory, "release.json"), JSON.stringify(release));
  const received: {
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
  }[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body: await text(request),
    });
    const json = (status: number, body: string) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(body);
    };
    if (request.method === "PUT") {
      json(
        uploadStatus,
        JSON.stringify(uploadStatus >= 400 ? { error: "fixture refusal" } : {}),
      );
      return;
    }
    const operation = {
      requestId,
      requestedInstallationId: "cli-demo",
      installationId: "cli-demo",
      release,
    };
    if (request.method === "POST") {
      // The durable owner acknowledges the retained command, then settles it.
      requestId = installationRequestIdSchema.parse(
        request.headers["idempotency-key"],
      );
      json(202, JSON.stringify({ ...operation, requestId, state: "pending" }));
      return;
    }
    json(
      200,
      JSON.stringify(
        outcome.state === "succeeded"
          ? {
              ...operation,
              state: "succeeded",
              installation: outcome.available ? installation : null,
              reference: {
                generation: "fixture-generation",
                instanceId: installation.instanceId,
                authorityVersion: installation.authority.authorityVersion,
                status: installation.status,
              },
              creation: "fresh",
              uiCheck: { kind: "passed" },
            }
          : { ...operation, ...outcome },
      ),
    );
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((cause: unknown) => {
      response.statusCode = 500;
      response.end(String(cause));
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = Schema.decodeUnknownSync(
    Schema.Struct({ port: Schema.Number }),
  )(server.address());
  const url = "http://127.0.0.1:" + String(address.port);
  return {
    directory,
    received,
    run: (source: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (done, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              cli,
              "install",
              source,
              "--installation-id",
              "cli-demo",
            ],
            {
              cwd: packageRoot,
              env: {
                ...process.env,
                HOME: directory,
                XDG_CONFIG_HOME: join(directory, "config"),
                OYSTER_URL: url,
                OYSTER_OWNER_KEY: key,
              },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => {
            done({ code, stdout, stderr });
          });
        },
      ),
    close: async () => {
      await new Promise<void>((done, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else done();
        });
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each(["directory", "release.json"])(
  "oyster install accepts %s and uploads artifacts before installation",
  async (form) => {
    const f = await fixture();
    try {
      const result = await f.run(
        form === "directory" ? f.directory : join(f.directory, "release.json"),
      );
      expect(result.code, result.stderr).toBe(0);
      expect(f.received.map((request) => request.method)).toEqual([
        "PUT",
        "POST",
        "GET",
      ]);
      expect(f.received[0]?.url).toContain(
        "/api/artifacts/artifact%3Aui?digest=sha256:",
      );
      expect(f.received[0]?.body).toBe("fixture-ui");
      expect(f.received[1]?.url).toBe("/api/installations");
      expect(JSON.parse(f.received[1]?.body ?? "null")).toEqual({
        release,
        installationId: "cli-demo",
      });
      expect(f.received[2]?.url).toMatch(
        /^\/api\/installations\/cli-demo\/status\?requestId=/u,
      );
      expect(f.received.map((request) => request.authorization)).toEqual([
        "Bearer " + key,
        "Bearer " + key,
        "Bearer " + key,
      ]);
      expect(result.stdout).toContain("cli-demo");
    } finally {
      await f.close();
    }
  },
);

it("an upload refusal exits nonzero without attempting installation", async () => {
  const f = await fixture(403);
  try {
    const result = await f.run(f.directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Artifact upload failed (403)");
    expect(result.stdout).toBe("");
    expect(f.received.map((request) => request.method)).toEqual(["PUT"]);
  } finally {
    await f.close();
  }
});

it("a missing release.json exits nonzero before any HTTP request", async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, "release.json"));
    const result = await f.run(f.directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stdout).toBe("");
    expect(f.received).toEqual([]);
  } finally {
    await f.close();
  }
});

it("a non-OK installation response is failure, never a printed success", async () => {
  const f = await fixture(201, {
    state: "refused",
    status: 503,
    code: "fixture refusal",
  });
  try {
    const result = await f.run(f.directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Installation failed (503)");
    expect(result.stderr).toContain("fixture refusal");
    expect(result.stdout).toBe("");
    expect(f.received.map((request) => request.method)).toEqual([
      "PUT",
      "POST",
      "GET",
    ]);
  } finally {
    await f.close();
  }
});

it("historical success without its exact current version is not printed as an installed result", async () => {
  const f = await fixture(201, { state: "succeeded", available: false });
  try {
    const result = await f.run(f.directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Installation failed (409)");
    expect(result.stderr).toContain("installation_result_unavailable");
    expect(result.stdout).toBe("");
    expect(f.received.map((request) => request.method)).toEqual([
      "PUT",
      "POST",
      "GET",
    ]);
  } finally {
    await f.close();
  }
});
