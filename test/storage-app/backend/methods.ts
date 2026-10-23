import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import {
  appCatalogResponseSchema,
  type AppCatalog,
} from "@fungi.computer/nacre/app-directory";
import type { AppStorageBinding } from "@fungi.computer/oyster/app-storage";
import { defineAppGill } from "@fungi.computer/agar/gills";

/** Native fixture uses the host-owned declared store, never facet SQLite. */
export type StorageContext = Readonly<{
  env: {
    APP_STORAGE: AppStorageBinding;
    APPS: { catalog(input: Record<never, never>): Promise<AppCatalog> };
  };
}>;
const output = z.json();
export const appBackend = defineAppBackend<StorageContext>({
  methods: {
    catalog: defineAppMethod({
      description: "Read installed surface and Gill metadata",
      effect: "read",
      requires: ["team.workbenchHost"],
      input: z.strictObject({}),
      output: appCatalogResponseSchema,
      handler: async (_, context) =>
        appCatalogResponseSchema.parse(await context.env.APPS.catalog({})),
    }),
    tryWriteFromRead: defineAppMethod({
      description: "Prove read methods cannot obtain a write binding",
      effect: "read",
      requires: ["app.storage"],
      input: z.strictObject({}),
      output,
      handler: async (_, context) =>
        output.parse(
          await context.env.APP_STORAGE.write({
            key: "desktop",
            scope: "team",
            basedOn: null,
            value: { forbidden: true },
          }),
        ),
    }),
    read: defineAppMethod({
      description: "Read the declared desktop key",
      effect: "read",
      requires: ["app.storage"],
      input: z.strictObject({
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output,
      handler: async (_, context) =>
        output.parse(await context.env.APP_STORAGE.read("desktop")),
    }),
    write: defineAppMethod({
      description: "Write the Team desktop layer",
      effect: "write",
      requires: ["app.storage"],
      input: z.strictObject({
        basedOn: z.number().int().positive().nullable(),
        value: z.json(),
      }),
      output,
      handler: async (input, context) =>
        output.parse(
          await context.env.APP_STORAGE.write({
            key: "desktop",
            scope: "team",
            ...input,
          }),
        ),
    }),
    holdThenWrite: defineAppMethod({
      description: "Hold a live frame, then write the Team desktop layer",
      effect: "write",
      requires: ["app.storage"],
      input: z.strictObject({
        holdMs: z.number().int().min(1).max(30000),
        basedOn: z.number().int().positive().nullable(),
        value: z.json(),
      }),
      output,
      handler: async ({ holdMs, ...input }, context) => {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        try {
          return output.parse(
            await context.env.APP_STORAGE.write({
              key: "desktop",
              scope: "team",
              ...input,
            }),
          );
        } catch (cause) {
          // The reinstall proof asserts the host's frame refusal code.
          if (cause instanceof Error && "code" in cause)
            return { refused: String(cause.code) };
          throw cause;
        }
      },
    }),
    reset: defineAppMethod({
      description: "Reset the Team desktop layer",
      effect: "write",
      requires: ["app.storage"],
      input: z.strictObject({
        basedOn: z.number().int().positive().nullable(),
      }),
      output,
      handler: async (input, context) =>
        output.parse(
          await context.env.APP_STORAGE.reset({
            key: "desktop",
            scope: "team",
            ...input,
          }),
        ),
    }),
  },
  gills: [
    defineAppGill({
      id: "inbox",
      title: "Inbox",
      source: "read",
      sizes: ["S", "M"],
      limit: 1,
      input: ({ limit }) => ({ limit }),
      rows: (value) => ({
        viewId: "inbox",
        title: "Inbox",
        state: "full",
        rows: [
          { id: "desktop", title: "Desktop", detail: JSON.stringify(value) },
        ],
      }),
    }),
  ],
});
