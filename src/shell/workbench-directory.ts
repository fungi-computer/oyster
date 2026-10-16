import * as z from "zod";
import {
  appDirectoryEntrySchema,
  appRoleSelectionSchema,
  appComputerPermissionSchema,
} from "./app-directory.js";
import { teamComputerSchema } from "./workbench-model.js";

const computerChoiceSchema = teamComputerSchema
  .pick({ computerId: true, name: true })
  .strip();

/** Desktop metadata shared by hosts; hosted administration stays in Settings. */
export const workbenchDirectorySchema = z
  .object({
    apps: z.array(
      appDirectoryEntrySchema
        .extend({
          computer: computerChoiceSchema.optional(),
          computerPermission: appComputerPermissionSchema.nullable().optional(),
        })
        .strip(),
    ),
    /** Fixed standalone context, not a Team Computer permission or capability grant. */
    computer: computerChoiceSchema.optional(),
    roles: z.record(z.string().min(1), appRoleSelectionSchema),
    needsUpdate: z
      .array(
        z.strictObject({
          installationId: z.string().min(1).nullable(),
          appId: z.string().min(1).nullable(),
          displayName: z.string().min(1),
        }),
      )
      .optional(),
  })
  .transform((directory) =>
    directory.computer === undefined
      ? directory
      : {
          ...directory,
          apps: directory.apps.map((app) => ({
            ...app,
            computer: directory.computer,
          })),
        },
  );
/** One host's current desktop rows and actual role selections. */
export type WorkbenchDirectory = z.output<typeof workbenchDirectorySchema>;
