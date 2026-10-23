import { Hono } from "hono";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { parseArtifactRef, parseSha256Digest } from "@fungi.computer/puffball";
import {
  createAppBuild,
  emptyAppDeclaration,
  type AppCapabilityId,
} from "@fungi.computer/puffball/app";
import { computerList } from "@fungi.computer/agar/computer";
import { agentApprovalRoutes, type OysterAgents } from "../agents.js";
import type { Installation } from "../apps/index.js";
import { fileCapabilities, type FileSource } from "../files.js";
import {
  createOyster,
  type CapabilityEnv,
  type OysterAuthResult,
  type OysterCapability,
  type OysterHost,
} from "../host.js";
import { instanceIds } from "../index.js";
import { sha256, verifyRelease } from "../release.js";
import { approvedInstallation } from "./installation.js";

/** How one capability fixture host admits its single installation. */
export type CapabilityFixtureOptions = Readonly<{
  /** `false` publishes a Release that declares no capability. */
  declared?: boolean;
  /** Capabilities the Release declares; defaults to `computer.list`. */
  capabilities?: readonly AppCapabilityId[];
  /** Adapters the host grants; defaults to a `computer.list` probe. */
  adapters?: readonly OysterCapability[];
  /** Grant the file adapters over this source instead of the probe. */
  fileSource?: FileSource;
  /** `false` clears the owner's approval after install. */
  admitted?: boolean;
  /** Serve a public installation to an anonymous visitor. */
  visitor?: boolean;
  authenticate?: (request: Request) => Promise<OysterAuthResult>;
  agents?: OysterAgents;
}>;

/** One Oyster host with a single installation whose capability grants the options shape. */
export async function capabilityFixture(
  options: CapabilityFixtureOptions = {},
) {
  const artifacts = new Map<string, Uint8Array>();
  async function put(bytes: Uint8Array) {
    const digest = parseSha256Digest(await sha256(bytes));
    const artifactRef = parseArtifactRef(`artifact:sha256-${digest.slice(7)}`);
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest };
  }
  const encode = (text: string) => new TextEncoder().encode(text);
  const uiBytes = encode("<!doctype html><title>Capability fixture</title>");
  const ui = {
    ...(await put(uiBytes)),
    version: "fixture",
    byteLength: uiBytes.length,
    mediaType: "text/html; charset=utf-8" as const,
  };
  async function release(
    releaseId: string,
    capabilities: readonly AppCapabilityId[],
  ): Promise<Installation["release"]> {
    const root = await put(
      encode(
        JSON.stringify(
          createAppBuild(ui, null, { capabilities, handlers: [], roles: [] }),
        ),
      ),
    );
    return Schema.decodeUnknownSync(releaseSchema)({
      releaseId,
      appId: "app_capability",
      artifact: {
        artifactRef: root.artifactRef,
        artifactDigest: root.digest,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: root.digest,
          buildRecipeDigest: root.digest,
        },
      },
    });
  }
  const routes = new Hono<CapabilityEnv>().post("/list", (context) =>
    context.json({ entries: [] }),
  );
  const capabilities: readonly OysterCapability[] =
    options.adapters ??
    (options.fileSource
      ? fileCapabilities(options.fileSource)
      : [
          {
            id: computerList.id,
            permission: "computer.list",
            version: computerList.version,
            base: "/probe/",
            routes,
            methods: { list: { kind: "json", method: "POST", path: "list" } },
          },
        ]);
  const declaredRelease = await release(
    "rel_declared",
    options.declared === false
      ? []
      : (options.capabilities ?? ["computer.list"]),
  );
  const declaration = (
    await verifyRelease(
      {
        get: (ref) => Promise.resolve(artifacts.get(ref) ?? null),
        put: () => Promise.reject(new Error("Fixture artifacts are read-only")),
      },
      declaredRelease,
    )
  ).declaration;

  let installation = await approvedInstallation({
    installationId: "capability-fixture",
    instanceId: instanceIds.instance.generate(),
    release: declaredRelease,
    declaration: declaration ?? emptyAppDeclaration,
    descriptors: capabilities,
  });
  if (options.admitted === false)
    installation = {
      ...installation,
      authority: {
        ...installation.authority,
        approvedGrants: [],
        approval: null,
      },
    };
  // An anonymous reader reaches only a public App, as the host's visitor.
  if (options.visitor) installation = { ...installation, visibility: "public" };
  const readOnly = () =>
    Promise.reject(new Error("Fixture installations are read-only"));
  const base: OysterHost = {
    bootUi: () => Promise.resolve({ kind: "passed" as const }),
    auth: {
      resolve: () =>
        Promise.reject(new Error("Capability fixture resolves no actor")),
      authenticate:
        options.authenticate ??
        ((request) =>
          Promise.resolve(
            options.visitor || request.headers.get("x-who") === "visitor"
              ? { kind: "refused", status: 401 }
              : {
                  kind: "admitted",
                  principal: {
                    actor: { kind: "member", memberId: "owner" },
                    role: "owner",
                  },
                },
          )),
    },
    artifacts: {
      get: (ref) => Promise.resolve(artifacts.get(ref) ?? null),
      put: () => Promise.reject(new Error("Fixture artifacts are read-only")),
    },
    installations: {
      generation: () => Promise.resolve("fixture-generation"),
      list: () => Promise.resolve([installation]),
      get: (id) =>
        Promise.resolve(
          id === installation.installationId ? installation : null,
        ),
      compareAndPut: readOnly,
    },
    instances: {
      get: () => {
        throw new Error("Capability routes must not execute an App backend");
      },
    },
    capabilities,
  };
  const host: OysterHost =
    options.agents === undefined
      ? base
      : { ...base, ownerRoutes: agentApprovalRoutes(options.agents) };
  const app = createOyster(host);
  return {
    app,
    page: () => app.request("https://oyster.test/apps/capability-fixture/"),
    request: () =>
      app.request("https://oyster.test/probe/list", {
        method: "POST",
        headers: { "X-Oyster-Installation": installation.installationId },
      }),
    async removeDeclaration() {
      installation = {
        ...installation,
        release: await release("rel_undeclared", []),
        authority: {
          ...installation.authority,
          authorityVersion: installation.authority.authorityVersion + 1,
        },
      };
    },
  };
}
