import * as Schema from "effect/Schema";
import {
  grantCommandSchema,
  installationSchema,
  type Installation,
} from "../apps/installation.js";
import { appPermissionPageSchema } from "../apps/permissions.js";
import type { InstallationOperation } from "../installation-operations.js";

/**
 * An owner choosing a freshly installed dashboard approves its declared shell
 * operations only. Replacements and tombstone remints never replay consent.
 */
export async function approveChosenDashboard(
  operation: Extract<InstallationOperation, { state: "succeeded" }>,
  owner: (
    method: "GET" | "PUT",
    path: string,
    body?: Schema.Json,
  ) => Promise<Response>,
): Promise<Installation | undefined> {
  if (operation.creation !== "fresh") return;
  const installed = operation.installation;
  const name = operation.installationId;
  if (installed === null)
    throw new Error(`${name} completed installation version is unavailable`);
  if (installed.status !== "enabled")
    throw new Error(`${name} fresh installation is not enabled`);
  const path = `/api/installations/${encodeURIComponent(name)}/grants`;
  const projectionResponse = await owner("GET", path);
  if (!projectionResponse.ok)
    throw new Error(
      `${name} approval read failed (${String(projectionResponse.status)})`,
    );
  const projection = appPermissionPageSchema.parse(
    await projectionResponse.json(),
  );
  const { permissions } = projection;
  const digest = installed.release.artifact.artifactDigest;
  if (
    projection.storeGeneration !== operation.reference.generation ||
    projection.installationId !== name ||
    projection.artifactDigest !== digest ||
    permissions.declaredOperations.artifactDigest !== digest ||
    permissions.authority.authorityVersion !==
      installed.authority.authorityVersion ||
    permissions.authority.declaredOperationsDigest !==
      installed.authority.declaredOperationsDigest ||
    permissions.declaredOperations.digest !==
      installed.authority.declaredOperationsDigest
  )
    throw new Error(`${name} approval snapshot changed`);
  const shell = permissions.declaredOperations.capabilities.find(
    (row) => row.capability === "team.workbenchHost",
  );
  if (shell === undefined) return;
  const command = grantCommandSchema.parse({
    kind: "change-grants",
    changes: [
      {
        capability: shell.capability,
        grant: { operations: shell.operations, resources: "tenant-scope" },
      },
    ],
  });
  const saved = await owner(
    "PUT",
    path,
    Schema.decodeUnknownSync(Schema.Json)({
      storeGeneration: projection.storeGeneration,
      authorityVersion: installed.authority.authorityVersion,
      artifactDigest: digest,
      command,
    }),
  );
  if (!saved.ok)
    throw new Error(`${name} approval failed (${String(saved.status)})`);
  const receipt = installationSchema.parse(await saved.json());
  if (
    receipt.installationId !== name ||
    receipt.instanceId !== installed.instanceId ||
    receipt.release.artifact.artifactDigest !== digest ||
    receipt.authority.authorityVersion !==
      installed.authority.authorityVersion + 1 ||
    !receipt.authority.approvedGrants.some(
      (grant) =>
        grant.capability === "team.workbenchHost" &&
        grant.resources === "tenant-scope" &&
        shell.operations.every((operation) =>
          grant.operations.includes(operation),
        ),
    )
  )
    throw new Error(`${name} approval incomplete`);
  return receipt;
}
