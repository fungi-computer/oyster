import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { fileCapabilities } from "../src/files.js";

export const release = Schema.decodeUnknownSync(releaseSchema)({
  appId: "app_notes",
  releaseId: "rel_notes",
  artifact: {
    artifactRef: "artifact:notes",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    provenance: {
      sourceRevision: `git:${"b".repeat(40)}`,
      sourceTreeDigest: `sha256:${"c".repeat(64)}`,
      buildRecipeDigest: `sha256:${"d".repeat(64)}`,
    },
  },
});
export const declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
  capabilities: ["computer.readFile", "computer.writeFile"],
  handlers: [],
  roles: [],
  commands: [],
  gills: [],
  backend: { bindings: [{ name: "COMPUTER", operations: ["read", "write"] }] },
  api: {
    methods: {
      "notes.read": {
        description: "Read a note",
        effect: "read",
        requires: ["computer.readFile"],
        input: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        output: { type: "object" },
      },
      "notes.write": {
        description: "Write a note",
        effect: "write",
        requires: ["computer.writeFile"],
        input: { type: "object" },
        output: { type: "object" },
      },
      "notes.external": {
        description: "External operation",
        effect: "external",
        requires: [],
        input: { type: "object" },
        output: { type: "object" },
      },
    },
  },
});
// Existing adapters supply descriptors; no operation catalog is authored by the host.
export const descriptors = fileCapabilities({
  list: () => Promise.resolve(null),
  read: () => Promise.resolve(null),
  write: () => Promise.resolve(),
  mkdir: () => Promise.resolve(),
  replace: () => Promise.resolve({ kind: "conflict" }),
});
