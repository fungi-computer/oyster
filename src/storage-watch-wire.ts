import * as Schema from "effect/Schema";
import {
  appStorageErrorCodeSchema,
  appStorageEventSchema,
} from "@fungi.computer/agar/storage";

/** One page watches many storage keys; browsers cap HTTP/1.1 hosts at six connections. */
export const maxStorageWatches = 64;

/** One watched storage key, named by the installation that owns it. */
export const storageWatchSchema = Schema.Tuple([Schema.String, Schema.String]);
export type StorageWatch = typeof storageWatchSchema.Type;

/**
 * What the shared stream says about one watch, by its position in the request:
 * the key is ready, the key changed, or the owner refused the watch with the
 * same code a dedicated read would have carried.
 */
export const storageWatchFrameSchema = Schema.Union([
  Schema.Struct({ watch: Schema.Number, kind: Schema.Literal("ready") }),
  Schema.Struct({
    watch: Schema.Number,
    kind: Schema.Literal("changed"),
    event: appStorageEventSchema,
  }),
  Schema.Struct({
    watch: Schema.Number,
    kind: Schema.Literal("rejected"),
    code: appStorageErrorCodeSchema,
  }),
]);
export type StorageWatchFrame = typeof storageWatchFrameSchema.Type;
