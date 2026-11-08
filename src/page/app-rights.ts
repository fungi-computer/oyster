import { APP_RIGHTS, type AppPermissions } from "@fungi.computer/agar";
import {
  pendingCapabilities,
  type AppPermissionsViewData,
} from "../apps/permissions.js";

/**
 * Which of an App's declared rights its owner's grants cover. Reads the same
 * facts the permission page shows, so the two never disagree. A right the App
 * does not declare is left out.
 */
export function appRightStates(
  page: Pick<AppPermissionsViewData, "permissions">,
): AppPermissions {
  const { authority, declaredOperations } = page.permissions;
  const declared = declaredOperations.capabilities.map(
    ({ capability }) => capability,
  );
  const missing = new Set<string>(
    pendingCapabilities(
      authority,
      { capabilities: declared },
      declaredOperations,
    ),
  );
  return Object.fromEntries(
    APP_RIGHTS.filter((right) => declared.some((name) => name === right)).map(
      (right) => [right, missing.has(right) ? "missing" : "granted"],
    ),
  );
}
