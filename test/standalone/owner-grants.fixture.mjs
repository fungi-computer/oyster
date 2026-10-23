import assert from "node:assert/strict";
import {
  appPermissionPageSchema,
  grantCommandSchema,
  installationSchema,
} from "@fungi.computer/oyster/apps";

/** The fixture owner explicitly consents after a fresh install. This uses the
 * ordinary owner door and its live CAS pins, never an installation exemption.
 * Callers assert 201 first; upgrades must still exercise needs-consent. */
export async function grantDeclaredAppCapabilities({
  origin,
  installationId,
  headers,
}) {
  const url = new globalThis.URL(
    "/api/installations/" + encodeURIComponent(installationId) + "/grants",
    origin,
  );
  const response = await globalThis.fetch(url, {
    headers: { ...headers, Accept: "application/json" },
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    200,
    "Read the owner's current grant projection",
  );
  const projection = appPermissionPageSchema.parse(await response.json());
  assert.equal(projection.installationId, installationId);
  assert.equal(
    projection.permissions.declaredOperations.artifactDigest,
    projection.artifactDigest,
  );
  const command = grantCommandSchema.parse({
    kind: "change-grants",
    changes: projection.permissions.declaredOperations.capabilities.map(
      ({ capability, operations }) => ({
        capability,
        grant: { operations, resources: "tenant-scope" },
      }),
    ),
  });
  const saved = await globalThis.fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      storeGeneration: projection.storeGeneration,
      authorityVersion: projection.permissions.authority.authorityVersion,
      artifactDigest: projection.artifactDigest,
      command,
    }),
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert.equal(
    saved.status,
    200,
    "The owner explicitly grants the declared operations",
  );
  const installed = installationSchema.parse(await saved.json());
  assert.equal(installed.installationId, installationId);
  assert.equal(
    installed.release.artifact.artifactDigest,
    projection.artifactDigest,
  );
  assert.equal(
    installed.authority.authorityVersion,
    projection.permissions.authority.authorityVersion + 1,
  );
}
