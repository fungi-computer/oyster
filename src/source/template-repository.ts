import { parseAppId } from "@fungi.computer/puffball";
import { appIdSchema } from "@fungi.computer/puffball/effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TEMPLATE_REPOSITORY_PREFIX = "template-";

/** Derive the private editable source repository from its validated App identity. */
export function templateRepositoryForApp(appId: string): string {
  const parsed = parseAppId(appId);
  // AppId's maximum 63-character suffix makes this repository at most 72 chars.
  return `${TEMPLATE_REPOSITORY_PREFIX}${parsed.slice("app_".length)}`;
}

/** The App whose template `repository` is, or null when it names none. */
export function appForTemplateRepository(repository: string): string | null {
  if (!repository.startsWith(TEMPLATE_REPOSITORY_PREFIX)) return null;
  const appId = Schema.decodeUnknownOption(appIdSchema)(
    `app_${repository.slice(TEMPLATE_REPOSITORY_PREFIX.length)}`,
  );
  return Option.isSome(appId) &&
    templateRepositoryForApp(appId.value) === repository
    ? appId.value
    : null;
}
