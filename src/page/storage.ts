import { RpcTarget } from "@fungi.computer/capnweb";
import * as Schema from "effect/Schema";
import { AppError } from "@fungi.computer/agar";
import {
  appStorageKeyNameSchema,
  appStorageWriteSchema,
  appStorageResetSchema,
  appStorageReadResultSchema,
  appStorageMutationResultSchema,
  type AppStorageWire,
  type AppStorageEventHandle,
  type AppStorageWrite,
  type AppStorageReset,
} from "@fungi.computer/agar/storage";

const NativeTarget: new () => object = RpcTarget;
function path(installationId: string, operation: string) {
  return `/api/workbench/storage/${encodeURIComponent(installationId)}/${operation}`;
}
async function reply(response: Response) {
  if (!response.ok)
    throw new AppError("App storage is unavailable", {
      code:
        response.status === 401 || response.status === 403
          ? "CAPABILITY_DENIED"
          : "HOST_FAILURE",
      retryable: response.status >= 500,
    });
  return Schema.decodeUnknownSync(Schema.Json)(await response.json());
}
class StorageEvents extends NativeTarget implements AppStorageEventHandle {
  readonly #abort = new AbortController();
  constructor(private readonly url: string) {
    super();
  }
  fetch(request: Request): Promise<Response> {
    return fetch(this.url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, this.#abort.signal]),
    });
  }
  close(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }
  [Symbol.dispose](): void {
    this.#abort.abort();
  }
}
class Storage extends NativeTarget implements AppStorageWire {
  constructor(private readonly installationId: string) {
    super();
  }
  async read(raw: string) {
    const key = Schema.decodeUnknownSync(appStorageKeyNameSchema)(raw);
    return Schema.decodeUnknownSync(appStorageReadResultSchema)(
      await reply(
        await fetch(
          `${path(this.installationId, "read")}?${new URLSearchParams({ key })}`,
          { credentials: "same-origin", cache: "no-store", redirect: "error" },
        ),
      ),
    );
  }
  async write(raw: AppStorageWrite) {
    const input = Schema.decodeUnknownSync(appStorageWriteSchema, {
      onExcessProperty: "error",
    })(raw);
    return Schema.decodeUnknownSync(appStorageMutationResultSchema)(
      await this.mutate("write", input),
    );
  }
  async reset(raw: AppStorageReset) {
    const input = Schema.decodeUnknownSync(appStorageResetSchema, {
      onExcessProperty: "error",
    })(raw);
    return Schema.decodeUnknownSync(appStorageMutationResultSchema)(
      await this.mutate("reset", input),
    );
  }
  private async mutate(
    operation: "write" | "reset",
    input: AppStorageWrite | AppStorageReset,
  ) {
    return reply(
      await fetch(path(this.installationId, operation), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    );
  }
  openEvents(raw: string): Promise<AppStorageEventHandle> {
    const key = Schema.decodeUnknownSync(appStorageKeyNameSchema)(raw);
    return Promise.resolve(
      new StorageEvents(
        `${path(this.installationId, "events")}?${new URLSearchParams({ key })}`,
      ),
    );
  }
}
/** The existing Agar storage wire, scoped to an admitted installation and owner. */
export function oysterStorageHandle(installationId: string): AppStorageWire {
  return new Storage(installationId);
}
