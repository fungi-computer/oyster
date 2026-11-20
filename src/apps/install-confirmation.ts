import type { AppCapabilityId } from "@fungi.computer/puffball/app";
import { permissionCatalog } from "./catalog.js";
import { installApprovedCapabilities } from "./installation.js";
import type { TeamRole } from "@fungi.computer/cairn/team-role";

/** One declared permission as the install confirmation words it. */
export type InstallConfirmationLine = Readonly<{
  capability: AppCapabilityId;
  label: string;
  description: string;
  warning: string | null;
  /** The Apps in this install that declare it. */
  apps: readonly string[];
}>;

/**
 * Every permission an install declares, once, for one confirmation. `granted`
 * is what confirming approves; `needsApproval` is what stays refused until an
 * owner approves it. Both come from the rule the install reducer applies, so
 * the list cannot promise more or less than the install does.
 */
export type InstallConfirmation = Readonly<{
  granted: readonly InstallConfirmationLine[];
  needsApproval: readonly InstallConfirmationLine[];
}>;

/** Merge any number of Apps into one combined, once-per-permission list. */
export function installConfirmation(
  role: TeamRole | null,
  apps: readonly Readonly<{
    name: string;
    capabilities: readonly AppCapabilityId[];
  }>[],
): InstallConfirmation {
  const granted = new Map<AppCapabilityId, string[]>();
  const waiting = new Map<AppCapabilityId, string[]>();
  for (const { name, capabilities } of apps) {
    const approved = new Set(installApprovedCapabilities(role, capabilities));
    for (const capability of capabilities) {
      // Affordances grant nothing and need no consent, so they are not listed.
      if (permissionCatalog[capability].consent === "affordance") continue;
      const into = approved.has(capability) ? granted : waiting;
      into.set(capability, [...(into.get(capability) ?? []), name]);
    }
  }
  const lines = (rows: Map<AppCapabilityId, string[]>) =>
    [...rows].map(([capability, names]): InstallConfirmationLine => {
      const entry = permissionCatalog[capability];
      return {
        capability,
        label: entry.label,
        description: entry.description,
        warning: entry.warning,
        apps: [...new Set(names)],
      };
    });
  return { granted: lines(granted), needsApproval: lines(waiting) };
}
