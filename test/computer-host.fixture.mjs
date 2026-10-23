import { installationStore } from "./native-approval-host.fixture.mjs";
import { approvedInstallation } from "../dist/testing/index.js";
import { verifyRelease } from "../dist/release.js";
import {
  appBackendActorHeader,
  appBackendComputerHeader,
} from "@fungi.computer/agar/backend";
import { instanceIds } from "../dist/index.js";
import { sha256 } from "../dist/release.js";

export async function computerHost(
  principal,
  computerId,
  display = {},
  capabilities = [],
  sourceRequires = [],
) {
  const artifacts = new Map();
  async function put(value) {
    const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, byteLength: bytes.length, version: digest };
  }
  const backend = await put({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "ContextProbe",
    code: "export class ContextProbe {}",
  });
  const root = await put({
    format: "fungi-app-v1",
    backend: {
      ...backend,
      mediaType: "application/vnd.fungi.app-backend+json",
    },
    declaration: {
      capabilities: ["computer.execute"],
      handlers: [],
      roles: [],
      ...display,
      api: {
        methods: {
          context: {
            description: "Observe the context passed to the App Instance",
            input: { type: "object" },
            output: { type: "object" },
            effect: "read",
            // This probe observes caller context; it never executes a Computer operation.
            requires: sourceRequires,
          },
          ...display.api?.methods,
        },
      },
    },
  });
  const initial = {
    installationId: "context-probe",
    instanceId: instanceIds.instance.generate(),
    release: {
      appId: "app_contextprobe",
      releaseId: "rel_contextprobe",
      artifact: {
        artifactRef: root.artifactRef,
        artifactDigest: root.digest,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: root.digest,
          buildRecipeDigest: root.digest,
        },
      },
    },
    authorityVersion: 1,
    status: "enabled",
  };
  const declaration = (
    await verifyRelease(
      { get: async (ref) => artifacts.get(ref) ?? null },
      initial.release,
    )
  ).declaration;
  if (declaration === null) throw new Error("Fixture declaration missing");
  const installation = await approvedInstallation({
    ...initial,
    declaration,
    descriptors: capabilities,
  });
  return {
    computerId,
    bootUi: () => Promise.resolve({ kind: "passed" }),
    capabilities,
    // A null principal is an anonymous request; the host may admit it as a visitor.
    auth: {
      authenticate: async () =>
        principal === null
          ? { kind: "refused", status: 401 }
          : { kind: "admitted", principal },
    },
    artifacts: { get: async (ref) => artifacts.get(ref) ?? null },
    installations: installationStore({
      get: async (id) =>
        id === installation.installationId ? installation : null,
      list: async () => [installation],
    }),
    instances: {
      get: () => ({
        prepare: () => Promise.resolve({ ok: true, value: { kind: "passed" } }),
        apply: async (state) => ({
          ok: true,
          value: {
            ...state,
            stateSchema: 1,
            desiredStatus: state.status,
            status: state.status === "enabled" ? "active" : state.status,
          },
        }),
        fetch: async (_selection, request) =>
          globalThis.Response.json({
            computerId: request.headers.get(appBackendComputerHeader),
            actorId: request.headers.get(appBackendActorHeader),
          }),
        // Observe the actual trusted context crossing the Instance RPC seam.
        call: async (facts) => {
          if (facts.subject.kind !== "call")
            throw new Error("Expected caller facts");
          return {
            ok: true,
            value: { kind: "ok", value: facts.subject.context },
          };
        },
      }),
    },
  };
}
