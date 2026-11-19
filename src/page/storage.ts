import { RpcTarget } from "@fungi.computer/capnweb";
import * as Schema from "effect/Schema";
import { AppError } from "@fungi.computer/agar";
import {
  appStorageKeyNameSchema,
  appStorageWriteSchema,
  appStorageResetSchema,
  appStorageClaimSchema,
  appStorageReadResultSchema,
  appStorageMutationResultSchema,
  appStorageClaimResultSchema,
  type AppStorageWire,
  type AppStorageEventHandle,
  type AppStorageWrite,
  type AppStorageReset,
  type AppStorageClaim,
} from "@fungi.computer/agar/storage";
import { storageEvents } from "./storage-events.js";

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
  constructor(
    private readonly installationId: string,
    private readonly key: string,
  ) {
    super();
  }
  /**
   * The App's own event stream, carried by the page's one shared stream. A
   * refused watch answers like a refused read, with the owner's code.
   */
  fetch(request: Request): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.#abort.signal]);
    const encoder = new TextEncoder();
    return new Promise((answer) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let answered = false;
      let stop: () => void = () => undefined;
      const body = new ReadableStream<Uint8Array>({
        start: (opened) => {
          controller = opened;
        },
        cancel: () => {
          stop();
        },
      });
      const reply = (response: Response) => {
        answered = true;
        answer(response);
      };
      stop = storageEvents.subscribe(
        this.installationId,
        this.key,
        (message) => {
          if (message.kind === "rejected") {
            stop();
            if (answered) controller?.error(new Error(message.code));
            else
              reply(
                Response.json(
                  { kind: "rejected", code: message.code },
                  { status: 403 },
                ),
              );
            return;
          }
          controller?.enqueue(
            encoder.encode(
              message.kind === "ready"
                ? "event: ready\ndata: {}\n\n"
                : `event: changed\ndata: ${JSON.stringify(message.event)}\n\n`,
            ),
          );
          if (!answered)
            reply(
              new Response(body, {
                headers: { "Content-Type": "text/event-stream" },
              }),
            );
        },
      );
      signal.addEventListener(
        "abort",
        () => {
          stop();
          if (answered) controller?.close();
          else reply(new Response(null, { status: 499 }));
        },
        { once: true },
      );
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
  async claim(raw: AppStorageClaim) {
    const input = Schema.decodeUnknownSync(appStorageClaimSchema, {
      onExcessProperty: "error",
    })(raw);
    return Schema.decodeUnknownSync(appStorageClaimResultSchema)(
      await this.mutate("claim", input),
    );
  }
  private async mutate(
    operation: "write" | "reset" | "claim",
    input: AppStorageWrite | AppStorageReset | AppStorageClaim,
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
    return Promise.resolve(new StorageEvents(this.installationId, key));
  }
}
/** The existing Agar storage wire, scoped to an admitted installation and owner. */
export function oysterStorageHandle(installationId: string): AppStorageWire {
  return new Storage(installationId);
}
