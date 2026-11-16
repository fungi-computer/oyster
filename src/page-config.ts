import * as Schema from "effect/Schema";
import { appDeclaredCommandSchema } from "@fungi.computer/puffball/app";
import { capabilityDescriptorSchema } from "./capability-descriptor.js";

/** One host-admitted configuration, shared by Worker producers and browser mounts. */
export const oysterAppConfigSchema = Schema.Struct({
  workbench: Schema.Boolean,
  /** The home shell Release's own module, imported top-level; null if it ships none. */
  shellModuleUrl: Schema.NullOr(Schema.String),
  storage: Schema.Boolean,
  /** The Release declares `apps.open`; only an embedding shell can serve it. */
  appsOpen: Schema.Boolean,
  computerId: Schema.NullOr(Schema.String),
  authorityVersion: Schema.Int,
  commands: Schema.Array(appDeclaredCommandSchema),
  icon: Schema.NullOr(Schema.String),
  roles: Schema.Array(Schema.String),
  installationId: Schema.String,
  appId: Schema.String,
  releaseId: Schema.String,
  uiUrl: Schema.String,
  backendUrl: Schema.String,
  methodsUrl: Schema.String,
  capabilities: Schema.Array(capabilityDescriptorSchema),
});
/** The host-admitted App configuration served by Oyster. */
/** Host-authored configuration for the ordinary sandboxed App mount. */
export type OysterAppConfig = typeof oysterAppConfigSchema.Type;
