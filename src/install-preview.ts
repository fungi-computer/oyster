import {
  installConfirmation,
  permissionCatalog,
  type InstallConfirmation,
} from "./apps/index.js";
import type { AppCapabilityId } from "@fungi.computer/puffball/app";

/** What the Oyster reports for one Release it would install. */
export type InstallPreview = Readonly<{
  name: string;
  capabilities: readonly AppCapabilityId[];
  /** Set when installing would update an existing installation. */
  update: Readonly<{
    installationId: string;
    needsApproval: readonly AppCapabilityId[];
  }> | null;
}>;

const lines = (rows: InstallConfirmation["granted"]) =>
  rows.map(
    (row) =>
      `${row.label}: ${row.description}${row.warning === null ? "" : ` ${row.warning}`} (${row.apps.join(", ")})`,
  );

/**
 * The one list an owner confirms: a fresh install grants by the shared rule;
 * an update keeps its current grants, so it lists only what newly waits.
 */
export function installPreviewNotes(
  previews: readonly InstallPreview[],
): readonly Readonly<{ title: string; lines: readonly string[] }>[] {
  const fresh = previews.filter(({ update }) => update === null);
  const confirmation = installConfirmation("owner", fresh);
  return [
    ...(confirmation.granted.length === 0
      ? []
      : [
          {
            title: `Installing ${fresh.map(({ name }) => name).join(", ")} lets them:`,
            lines: lines(confirmation.granted),
          },
        ]),
    ...(confirmation.needsApproval.length === 0
      ? []
      : [
          {
            title:
              "Not granted by installing; approve in Settings > Permissions:",
            lines: lines(confirmation.needsApproval),
          },
        ]),
    ...previews.flatMap(({ name, update }) =>
      update === null
        ? []
        : [
            {
              title: `Updating ${update.installationId} (${name}) keeps its current permissions:`,
              lines:
                update.needsApproval.length === 0
                  ? ["Nothing new is requested."]
                  : [
                      "Newly requested, waiting for approval in Settings > Permissions:",
                      ...update.needsApproval.map(
                        (capability) => permissionCatalog[capability].label,
                      ),
                    ],
            },
          ],
    ),
  ];
}
