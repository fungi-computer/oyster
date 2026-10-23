import { expect, it } from "vitest";
import { parseReleaseId, parseSha256Digest } from "@fungi.computer/puffball";
import { isCommittedInstallation } from "../src/apps/installation.js";
import { instanceIds, selectionOf, type OwnerState } from "../src/index.js";
import { approvedInstallation } from "../src/testing/installation.js";
import { release, declaration, descriptors } from "./apps-fixture.js";

it("activation requires the exact committed owner, version, status, Instance and Release", async () => {
  const installation = await approvedInstallation({
    release,
    declaration,
    descriptors,
    installationId: "notes",
    instanceId: instanceIds.instance.generate(),
  });
  const state: OwnerState = {
    ...selectionOf(installation),
    status: installation.status,
  };
  expect(isCommittedInstallation(installation, state, release)).toBe(true);
  expect(isCommittedInstallation(null, state, release)).toBe(false);
  const stale: readonly OwnerState[] = [
    { ...state, authorityVersion: state.authorityVersion + 1 },
    { ...state, status: "disabled" },
    { ...state, releaseId: parseReleaseId("rel_other") },
    { ...state, instanceId: instanceIds.instance.generate() },
    { ...state, owner: { kind: "installation", id: "other" } },
    { ...state, owner: { kind: "deployment", id: state.owner.id } },
  ];
  for (const input of stale)
    expect(isCommittedInstallation(installation, input, release)).toBe(false);
  expect(
    isCommittedInstallation(installation, state, {
      ...release,
      artifact: {
        ...release.artifact,
        artifactDigest: parseSha256Digest("sha256:" + "f".repeat(64)),
      },
    }),
  ).toBe(false);
  expect(
    isCommittedInstallation(
      { ...installation, status: "deleted" },
      state,
      release,
    ),
  ).toBe(false);
});
