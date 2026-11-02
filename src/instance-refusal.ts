import { BootGateError, bootFailureSchema } from "./boot-gate.js";
import type { AppInstanceErrorCode } from "./index.js";

const conflicts: ReadonlySet<string> = new Set([
  "conflicting_owner_state",
  "stale_authority",
  "instance_release_mismatch",
  "release_no_longer_matches_instance",
  "state_schema_migration_unsupported",
]);

/** The retained HTTP meaning of a known Instance refusal, never generic failed. */
export function instanceRefusalStatus(code: AppInstanceErrorCode): number {
  if (bootFailureSchema.safeParse(code).success) return 422;
  return conflicts.has(code) ? 409 : 403;
}

/** The host-authored settlement for an installation that changed nothing. */
export const installationNotAppliedMessage =
  "The new release was not applied: Oyster could not prepare it. The previous release is still installed; install again to retry.";

/** Only closed host-authored reasons produce a caller-facing message. */
export function instanceRefusalBody(code: string) {
  if (code === "installation_not_applied")
    return { error: code, message: installationNotAppliedMessage };
  const boot = bootFailureSchema.safeParse(code);
  return boot.success
    ? { error: boot.data, message: new BootGateError(boot.data).message }
    : { error: code };
}
