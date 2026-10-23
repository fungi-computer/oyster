import * as Schema from "effect/Schema";
import { appIdSchema } from "@fungi.computer/puffball/effect";
import {
  appCatalogResponseSchema,
  type AppCatalog,
} from "@fungi.computer/nacre/app-directory";
import type { OysterRootDirectory } from "./root-data.js";
import type { FrameBindingMethods } from "./cloudflare.js";
import type { OysterBindingResult } from "./workers.js";

/** Guest input for `APPS.fork`: the platform App to fork and a chosen label. */
export const appForkInputSchema = Schema.Struct({
  platformAppId: appIdSchema,
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(63)),
  ),
});
export type AppForkInput = Schema.Schema.Type<typeof appForkInputSchema>;

/** The closed result union `forkAppSource` already returns. */
export const appForkResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("forked"),
    appId: Schema.String,
    repository: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals(["unauthorized", "conflict", "provider_unavailable"]),
  }),
]);

/** Canonical read-only App metadata, projected from the existing root
 * directory. Typed as the binding's own result, so every consumer --
 * in this package or across one -- gets the real return type directly. */
export function oysterAppCatalog(
  directory: OysterRootDirectory,
): OysterBindingResult {
  const roles: AppCatalog["roles"] = {};
  if (directory.roles.inbox !== undefined) roles.inbox = directory.roles.inbox;
  return appCatalogResponseSchema.parse({
    apps: directory.apps
      .filter(
        (app) =>
          app.availability === "available" &&
          app.surface !== null &&
          app.releaseId !== null &&
          !app.roles.includes("dashboard"),
      )
      .map((app) => {
        const entry: AppCatalog["apps"][number] = {
          surfaceId: app.surfaceId,
          appId: app.appId,
          gills: app.gills.map((gill) => {
            const metadata: AppCatalog["apps"][number]["gills"][number] = {
              id: gill.id,
              title: gill.title,
            };
            if (gill.desktop !== undefined)
              metadata.desktop = { sizes: [...gill.desktop.sizes] };
            return metadata;
          }),
        };
        if (app.displayName !== undefined) entry.displayName = app.displayName;
        return entry;
      }),
    roles,
  });
}
/** The plain host exposes only `catalog`; a Git-capable host also wires `fork`. */
export const catalogFrameMethods = {
  APPS: {
    catalog: {
      decodeArgs: Schema.decodeUnknownSync(Schema.Tuple([Schema.Struct({})]), {
        onExcessProperty: "error",
      }),
      decodeResult: (raw): OysterBindingResult =>
        appCatalogResponseSchema.parse(raw),
      requiredOperations: () => ["catalog"],
    },
    fork: {
      decodeArgs: Schema.decodeUnknownSync(Schema.Tuple([appForkInputSchema]), {
        onExcessProperty: "error",
      }),
      decodeResult: (raw): OysterBindingResult =>
        Schema.decodeUnknownSync(appForkResultSchema)(raw),
      requiredOperations: () => ["fork"],
    },
  },
} satisfies FrameBindingMethods<OysterBindingResult>;
