import * as Schema from "effect/Schema";
import {
  appStorageKeyNameSchema,
  appStorageWriteSchema,
  appStorageResetSchema,
  appStorageReadResultSchema,
  appStorageMutationResultSchema,
} from "@fungi.computer/agar/storage";
import type { FrameBindingMethods } from "./cloudflare.js";
import type { OysterBindingResult } from "./workers.js";

/** The storage codecs and operation checks used by both sides of the native frame. */
export const storageFrameMethods = {
  APP_STORAGE: {
    read: {
      decodeArgs: Schema.decodeUnknownSync(
        Schema.Tuple([appStorageKeyNameSchema]),
        { onExcessProperty: "error" },
      ),
      decodeResult: Schema.decodeUnknownSync(appStorageReadResultSchema, {
        onExcessProperty: "error",
      }),
      requiredOperations: () => ["read"],
    },
    write: {
      decodeArgs: Schema.decodeUnknownSync(
        Schema.Tuple([appStorageWriteSchema]),
        { onExcessProperty: "error" },
      ),
      decodeResult: Schema.decodeUnknownSync(appStorageMutationResultSchema, {
        onExcessProperty: "error",
      }),
      requiredOperations: () => ["write"],
    },
    reset: {
      decodeArgs: Schema.decodeUnknownSync(
        Schema.Tuple([appStorageResetSchema]),
        { onExcessProperty: "error" },
      ),
      decodeResult: Schema.decodeUnknownSync(appStorageMutationResultSchema, {
        onExcessProperty: "error",
      }),
      requiredOperations: () => ["reset"],
    },
  },
} satisfies FrameBindingMethods<OysterBindingResult>;
