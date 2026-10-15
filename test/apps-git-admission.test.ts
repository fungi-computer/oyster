import { expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { createInstallationGitAdmission } from "../src/git.js";
import { instanceIds } from "../src/index.js";
import type { Installation } from "../src/apps/installation.js";
import { approvedInstallation } from "../dist/testing/index.js";
import { release } from "./apps-fixture.js";

async function fixture() {
  const declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: ["git.repository"],
    handlers: [],
    roles: [],
    backend: { bindings: [{ name: "GIT", operations: ["read", "write"] }] },
  });
  const installation = await approvedInstallation({
    release,
    declaration,
    installationId: "notes",
    instanceId: instanceIds.instance.generate(),
  });
  let current: Installation | null = installation;
  const currentInstallation = vi.fn(() => Promise.resolve(current));
  const verifiedDeclaration = vi.fn(() => Promise.resolve(declaration));
  const admits = createInstallationGitAdmission({
    currentInstallation,
    declaration: verifiedDeclaration,
  });
  return {
    installation,
    declaration,
    admits,
    currentInstallation,
    verifiedDeclaration,
    setCurrent(value: Installation | null) {
      current = value;
    },
  };
}
const writer = {
  kind: "actor",
  actor: { kind: "member", memberId: "fixture-owner" },
} as const;

it("reopens live installation and verified Release declaration for admission without a provider port", async () => {
  const f = await fixture();
  await expect(f.admits(writer, "notes", "read")).resolves.toBe(true);
  await expect(f.admits(writer, "notes", "write")).resolves.toBe(true);
  expect(f.currentInstallation).toHaveBeenCalledTimes(2);
  expect(f.verifiedDeclaration).toHaveBeenCalledTimes(2);
  expect(f.verifiedDeclaration).toHaveBeenLastCalledWith(f.installation);
  f.setCurrent(null);
  await expect(f.admits(writer, "notes", "write")).resolves.toBe(false);
  expect(f.verifiedDeclaration).toHaveBeenCalledTimes(2);
});

it("refuses a verified Release without git.repository", async () => {
  const f = await fixture();
  f.verifiedDeclaration.mockResolvedValue({
    ...f.declaration,
    capabilities: [],
  });
  await expect(f.admits(writer, "notes", "read")).resolves.toBe(false);
  await expect(f.admits(writer, "notes", "write")).resolves.toBe(false);
});

it("keeps the existing anonymous visibility rule on the same live reader", async () => {
  const f = await fixture();
  await expect(f.admits(null, "notes", "read")).resolves.toBe(false);
  f.setCurrent({ ...f.installation, visibility: "public" });
  await expect(f.admits(null, "notes", "read")).resolves.toBe(true);
  f.setCurrent({ ...f.installation, visibility: "private" });
  await expect(f.admits(null, "notes", "read")).resolves.toBe(false);
});
