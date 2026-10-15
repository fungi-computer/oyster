import { parseAppId } from "@fungi.computer/puffball";

const TEMPLATE_REPOSITORY_PREFIX = "template-";

/** Derive the private editable source repository from its validated App identity. */
export function templateRepositoryForApp(appId: string): string {
  const parsed = parseAppId(appId);
  // AppId's maximum 63-character suffix makes this repository at most 72 chars.
  return `${TEMPLATE_REPOSITORY_PREFIX}${parsed.slice("app_".length)}`;
}
