import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  approvedGrantSchema,
  unstampedFingerprint,
} from "./apps/installation.js";

/** An approved grant as Oyster 0.28 and earlier stored it, before fingerprints. */
const legacyGrantSchema = approvedGrantSchema
  .unwrap()
  .omit({ fingerprints: true })
  .transform((grant) => ({
    ...grant,
    fingerprints: Object.fromEntries(
      grant.operations.map((operation) => [operation, unstampedFingerprint]),
    ),
  }));
/** A grant already in the current shape fails the strict legacy schema and is kept. */
const grantSchema = z.union([legacyGrantSchema, z.unknown()]);
const installationSchema = z.looseObject({
  authority: z.looseObject({ approvedGrants: z.array(grantSchema) }),
});

/**
 * The one migration step for stored installations: grants written before
 * fingerprints gain `unstampedFingerprint` for each approved operation, which
 * the first release snapshot replaces. Stored approvals keep working and the
 * old shape disappears from storage. Anything else passes through unchanged.
 */
const migrateInstallation = z.union([installationSchema, z.unknown()]);
/** A retained command: its baseline and planned installation. */
const commandSchema = z.looseObject({
  baseline: migrateInstallation.optional(),
  plan: z.looseObject({ installation: migrateInstallation }).nullish(),
});
/** A provisional outcome: the installation a command reported. */
const outcomeSchema = z.looseObject({
  installation: migrateInstallation.optional(),
});
const installationRowSchema = z.strictObject({
  installation_id: z.string(),
  record: z.string(),
});
const commandRowSchema = z.strictObject({
  request_id: z.string(),
  command: z.string(),
  provisional_outcome: z.string().nullable(),
});

/** Re-encode stored JSON (the query admits only valid JSON); null unless the migration changed it. */
function reencode(text: string, schema: z.ZodType): string | null {
  const stored: unknown = JSON.parse(text);
  const migrated = schema.safeParse(stored);
  return migrated.success && !isDeepStrictEqual(stored, migrated.data)
    ? JSON.stringify(migrated.data)
    : null;
}

/** Rewrite every stored installation to the current approval contract, once. */
export function migrateInstallationRows(owner: WatchdogSqliteOwner): void {
  owner.transactionSync(() => {
    for (const row of owner.sql
      .exec(
        "SELECT installation_id, record FROM installations WHERE json_valid(record)",
      )
      .toArray()) {
      const { installation_id, record } = installationRowSchema.parse(row);
      const next = reencode(record, installationSchema);
      if (next !== null)
        owner.sql.exec(
          "UPDATE installations SET record=? WHERE installation_id=?",
          next,
          installation_id,
        );
    }
  });
}

/** Retained commands and provisional outcomes embed installations; migrate them alike. */
export function migrateCommandRows(owner: WatchdogSqliteOwner): void {
  owner.transactionSync(() => {
    for (const row of owner.sql
      .exec(
        "SELECT request_id, command, provisional_outcome FROM installation_commands WHERE json_valid(command) AND (provisional_outcome IS NULL OR json_valid(provisional_outcome))",
      )
      .toArray()) {
      const { request_id, command, provisional_outcome } =
        commandRowSchema.parse(row);
      const nextCommand = reencode(command, commandSchema);
      const nextOutcome =
        provisional_outcome === null
          ? null
          : reencode(provisional_outcome, outcomeSchema);
      if (nextCommand !== null || nextOutcome !== null)
        owner.sql.exec(
          "UPDATE installation_commands SET command=?, provisional_outcome=? WHERE request_id=?",
          nextCommand ?? command,
          nextOutcome ?? provisional_outcome,
          request_id,
        );
    }
  });
}
