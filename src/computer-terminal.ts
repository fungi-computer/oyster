import { AppError } from "@fungi.computer/agar";
import type {
  AppComputerTerminal,
  ComputerTerminalSize,
  ComputerTerminalInformation,
} from "@fungi.computer/agar/computer";
import {
  type computerTerminal,
  computerTerminalInformationSchema,
} from "@fungi.computer/agar/computer";
import { LONG, nanoid } from "@fungi.computer/cairn";
import { RpcTarget } from "@fungi.computer/capnweb";
import type * as z from "zod";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** Current host admission for the Computer captured when the terminal opened. */
export type ComputerTerminalSelection = Readonly<{
  computerId: string | null;
  terminalUrl: string | null;
}>;

/** Host admission on connection and lease renewal; unleased input rechecks it. */
export type ComputerTerminalAccess = ((
  signal: AbortSignal,
) => Promise<ComputerTerminalSelection>) & {
  /** Current admission deadline, when the host uses expiring leases. */
  leaseExpiresAt?: () => number | null;
};

/** Host transport construction; the shared protocol owns PTY session identity. */
export type ComputerTerminalConnect = (
  terminalUrl: string,
  input: ComputerTerminalSize & Readonly<{ session: string }>,
) => WebSocket;

/** Host policy and browser lifetime surrounding the retained PTY protocol. */
export type ComputerTerminalHostOptions = Readonly<{
  terminalUrl: string;
  computerId: string | null;
  hostWindow: Readonly<{
    /** Schedule a reconnect or admission lease check. */
    setTimeout: (callback: () => void, delayMs: number) => number;
    /** Cancel a pending reconnect or admission lease check. */
    clearTimeout: (timer: number) => void;
  }>;
  ensureAccess: ComputerTerminalAccess;
  connect: ComputerTerminalConnect;
  mountSignal: AbortSignal | undefined;
}>;

const terminalControlEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    information: computerTerminalInformationSchema,
  }),
  Schema.Struct({ type: Schema.Literals(["exit", "error"]) }),
]);
const terminalFrameSchema = Schema.Union([
  Schema.fromJsonString(terminalControlEventSchema),
  Schema.instanceOf(ArrayBuffer),
  Schema.instanceOf(Blob),
  Schema.instanceOf(Uint8Array),
]);
type TerminalFrame = (typeof terminalFrameSchema)["Type"];
const decodeTerminalFrame = Schema.decodeUnknownSync(terminalFrameSchema);
const terminalFailureSchema = Schema.toType(Schema.Defect()).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (failure) => String(failure),
      encode: (message) => message,
    }),
  ),
);
const decodeTerminalFailure = Schema.decodeUnknownSync(terminalFailureSchema);
const terminalSizeSchema = Schema.Struct({
  cols: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 2, maximum: 500 })),
  ),
  rows: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 2, maximum: 300 })),
  ),
});
const decodeTerminalSize = Schema.decodeUnknownSync(terminalSizeSchema);
const decodeTerminalInput = Schema.decodeUnknownSync(
  Schema.instanceOf(Uint8Array),
);

/** Terminal operations and lifetime for one admitted App window. */
export type ComputerTerminalHost = {
  /** Open an admitted PTY and retain its session across transport reconnects. */
  open(size: ComputerTerminalSize): Promise<AppComputerTerminal>;
  /** Close every terminal when the App window's host lifetime ends. */
  [Symbol.dispose](): void;
};

class ComputerTerminalHostImplementation
  extends RpcTarget
  implements z.output<typeof computerTerminal.schema>
{
  readonly #sessions = new Set<ComputerTerminalSession>();
  readonly #terminalUrl: string;
  readonly #computerId: string | null;
  readonly #connectSocket: ComputerTerminalConnect;
  readonly #hostWindow: ComputerTerminalHostOptions["hostWindow"];
  readonly #ensureAccess: ComputerTerminalAccess;
  readonly #mountSignal: AbortSignal | undefined;
  readonly #abort = () => {
    this[Symbol.dispose]();
  };
  #disposed = false;

  constructor(options: ComputerTerminalHostOptions) {
    super();
    this.#terminalUrl = options.terminalUrl;
    this.#computerId = options.computerId;
    this.#connectSocket = options.connect;
    this.#hostWindow = options.hostWindow;
    this.#ensureAccess = options.ensureAccess;
    this.#mountSignal = options.mountSignal;
    this.#mountSignal?.addEventListener("abort", this.#abort, { once: true });
    if (this.#mountSignal?.aborted) this.#abort();
  }

  /** Open an admitted PTY and retain its session across transport reconnects. */
  async open(size: ComputerTerminalSize): Promise<AppComputerTerminal> {
    if (this.#disposed) throw new Error("App Computer terminal is closed");
    const session = new ComputerTerminalSession({
      terminalUrl: this.#terminalUrl,
      computerId: this.#computerId,
      connect: this.#connectSocket,
      hostWindow: this.#hostWindow,
      ensureAccess: this.#ensureAccess,
      mountSignal: this.#mountSignal,
      release: (terminal) => {
        this.#sessions.delete(terminal);
      },
    });
    this.#sessions.add(session);
    try {
      await session.start(decodeTerminalSize(size));
      return session;
    } catch (error) {
      session[Symbol.dispose]();
      throw error;
    }
  }

  /** Close every terminal when the App window's host lifetime ends. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mountSignal?.removeEventListener("abort", this.#abort);
    for (const session of this.#sessions) session[Symbol.dispose]();
    this.#sessions.clear();
  }
}

/** Construct the shared terminal owner with host policy and transport edges. */
export const ComputerTerminalHost: new (
  options: ComputerTerminalHostOptions,
) => ComputerTerminalHost = ComputerTerminalHostImplementation;

class ComputerTerminalSession extends RpcTarget implements AppComputerTerminal {
  readonly #controller = new AbortController();
  readonly #abort = () => {
    this[Symbol.dispose]();
  };
  readonly #release: (terminal: ComputerTerminalSession) => void;
  readonly #hostWindow: ComputerTerminalHostOptions["hostWindow"];
  readonly #computerId: string | null;
  readonly #connectSocket: ComputerTerminalConnect;
  readonly #ensureAccess: ComputerTerminalAccess;
  readonly #mountSignal: AbortSignal | undefined;
  readonly #output: ReadableStream<Uint8Array>;
  readonly #input: WritableStream<Uint8Array>;
  #outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  #inputController: WritableStreamDefaultController | undefined;
  #terminalUrl: string;
  #sessionId = nanoid(LONG);
  #size: ComputerTerminalSize = { cols: 80, rows: 24 };
  #socket: WebSocket | undefined;
  #connectPromise: Promise<void> | undefined;
  #accessPromise: Promise<ComputerTerminalSelection> | undefined;
  #retryTimer: number | undefined;
  #leaseTimer: number | undefined;
  // A refused peer session must never extend this session's admitted lease.
  #leaseExpiresAt: number | null | undefined;
  #attempt = 0;
  #sawOutput = false;
  #deadShell = false;
  #closed = false;
  #outputDone = false;
  #information: ComputerTerminalInformation | undefined;
  #informationWait: Promise<ComputerTerminalInformation> | undefined;
  #resolveInformation:
    ((information: ComputerTerminalInformation) => void) | undefined;
  #rejectInformation: ((error: Error) => void) | undefined;

  constructor(
    options: ComputerTerminalHostOptions & {
      release: (terminal: ComputerTerminalSession) => void;
    },
  ) {
    super();
    this.#terminalUrl = options.terminalUrl;
    this.#computerId = options.computerId;
    this.#connectSocket = options.connect;
    this.#hostWindow = options.hostWindow;
    this.#ensureAccess = options.ensureAccess;
    this.#mountSignal = options.mountSignal;
    this.#release = options.release;
    this.#output = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#outputController = controller;
      },
      cancel: () => {
        this.#outputDone = true;
        return this.close();
      },
    });
    this.#input = new WritableStream<Uint8Array>({
      start: (controller) => {
        this.#inputController = controller;
      },
      write: (chunk: Uint8Array) => this.#write(chunk),
      close: () => this.close(),
      abort: () => this.close(),
    });
    this.#mountSignal?.addEventListener("abort", this.#abort, { once: true });
    if (this.#mountSignal?.aborted) this.#abort();
  }

  async start(size: ComputerTerminalSize): Promise<void> {
    this.#size = size;
    await this.#connect();
  }

  information(): Promise<ComputerTerminalInformation> {
    if (this.#closed)
      return Promise.reject(new Error("Computer terminal is closed"));
    if (this.#information !== undefined)
      return Promise.resolve(this.#information);
    this.#informationWait ??= new Promise((resolve, reject) => {
      this.#resolveInformation = resolve;
      this.#rejectInformation = reject;
    });
    return this.#informationWait;
  }

  output(): Promise<ReadableStream<Uint8Array>> {
    if (this.#closed)
      return Promise.reject(new Error("Computer terminal is closed"));
    return Promise.resolve(this.#output);
  }

  input(): Promise<WritableStream<Uint8Array>> {
    if (this.#closed)
      return Promise.reject(new Error("Computer terminal is closed"));
    return Promise.resolve(this.#input);
  }

  async resize(size: ComputerTerminalSize): Promise<void> {
    const nextSize = decodeTerminalSize(size);
    await this.#ensureLease();
    const socket = await this.#readySocket();
    socket.send(JSON.stringify({ type: "resize", ...nextSize }));
    this.#size = nextSize;
  }

  close(): Promise<void> {
    this[Symbol.dispose]();
    return Promise.resolve();
  }

  [Symbol.dispose](): void {
    this.#shutdown();
  }

  async #write(chunk: Uint8Array): Promise<void> {
    const bytes = decodeTerminalInput(chunk);
    await this.#ensureLease();
    const socket = await this.#readySocket();
    socket.send(bytes);
  }

  async #readySocket(): Promise<WebSocket> {
    while (!this.#closed) {
      if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
      await (this.#connectPromise ?? this.#connect());
    }
    throw new Error("Computer terminal is closed");
  }

  #connect(): Promise<void> {
    if (this.#closed)
      return Promise.reject(new Error("Computer terminal is closed"));
    if (this.#connectPromise !== undefined) return this.#connectPromise;
    const connecting = this.#openSocket().finally(() => {
      if (this.#connectPromise === connecting) this.#connectPromise = undefined;
    });
    this.#connectPromise = connecting;
    return connecting;
  }

  async #openSocket(): Promise<void> {
    const configuration = await this.#ensureCurrent();
    const terminalUrl = configuration.terminalUrl ?? this.#terminalUrl;
    this.#terminalUrl = terminalUrl;
    this.#attempt += 1;
    this.#sawOutput = false;
    this.#deadShell = false;
    const socket = this.#connectSocket(terminalUrl, {
      session: this.#sessionId,
      ...this.#size,
    });
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.#closed || socket !== this.#socket) return;
      try {
        const frame = decodeTerminalFrame(event.data);
        void this.#writeOutput(frame).catch((error: unknown) => {
          this.#fail(decodeTerminalFailure(error));
        });
      } catch (error) {
        this.#fail(decodeTerminalFailure(error));
      }
    });
    socket.addEventListener("close", () => {
      this.#socketClosed(socket);
    });
    socket.addEventListener("error", () => {
      /* The close event owns reconnect and teardown. */
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
        resolve();
      };
      const onClose = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
        reject(new Error("Computer terminal connection closed"));
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  async #writeOutput(frame: TerminalFrame): Promise<void> {
    if (Schema.is(terminalControlEventSchema)(frame)) {
      switch (frame.type) {
        case "ready":
          this.#information = frame.information;
          this.#resolveInformation?.(frame.information);
          this.#resolveInformation = undefined;
          this.#rejectInformation = undefined;
          return;
        case "error":
          return;
        case "exit":
          this.#deadShell = true;
          return;
      }
    }
    let bytes: Uint8Array;
    if (frame instanceof ArrayBuffer) bytes = new Uint8Array(frame);
    else if (frame instanceof Blob)
      bytes = new Uint8Array(await frame.arrayBuffer());
    else bytes = frame;
    if (this.#closed) return;
    this.#sawOutput = true;
    this.#outputController?.enqueue(bytes);
  }

  #socketClosed(socket: WebSocket): void {
    if (this.#closed || socket !== this.#socket) return;
    this.#socket = undefined;
    if (this.#deadShell || !this.#sawOutput) this.#sessionId = nanoid(LONG);
    const delay = Math.min(30_000, 3_000 + this.#attempt * 3_000);
    this.#retryTimer = this.#hostWindow.setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#connect().catch((error: unknown) => {
        this.#fail(decodeTerminalFailure(error));
      });
    }, delay);
  }

  async #ensureLease(): Promise<void> {
    if (this.#closed) throw new Error("Computer terminal is closed");
    const expiresAt = this.#leaseExpiresAt;
    if (
      expiresAt === undefined ||
      expiresAt === null ||
      expiresAt <= Date.now()
    )
      await this.#ensureCurrent();
  }

  #ensureCurrent(): Promise<ComputerTerminalSelection> {
    if (this.#closed)
      return Promise.reject(new Error("Computer terminal is closed"));
    this.#accessPromise ??= this.#checkCurrent()
      .then((selection) => {
        this.#scheduleLeaseCheck();
        return selection;
      })
      .finally(() => {
        this.#accessPromise = undefined;
      });
    return this.#accessPromise;
  }

  async #checkCurrent(): Promise<ComputerTerminalSelection> {
    if (this.#closed) throw new Error("Computer terminal is closed");
    let configuration: ComputerTerminalSelection;
    try {
      configuration = await this.#ensureAccess(this.#controller.signal);
    } catch (error) {
      const failure = decodeTerminalFailure(error);
      this.#fail(failure);
      throw new Error(failure, { cause: error });
    }
    this.#controller.signal.throwIfAborted();
    if (
      this.#computerId === null ||
      configuration.computerId !== this.#computerId
    ) {
      const error = new AppError(
        "The selected Computer changed. Retry on the original Computer.",
        { code: "CAPABILITY_DENIED", retryable: false },
      );
      this.#shutdown(error);
      throw error;
    }
    if (configuration.terminalUrl === null) {
      const error = new AppError("Computer terminal is unavailable", {
        code: "CAPABILITY_DENIED",
        retryable: false,
      });
      this.#shutdown(error);
      throw error;
    }
    this.#leaseExpiresAt = this.#ensureAccess.leaseExpiresAt?.();
    return configuration;
  }

  #scheduleLeaseCheck(): void {
    if (this.#leaseTimer !== undefined)
      this.#hostWindow.clearTimeout(this.#leaseTimer);
    this.#leaseTimer = undefined;
    if (this.#closed) return;
    const expiresAt = this.#leaseExpiresAt;
    if (expiresAt === undefined || expiresAt === null) return;
    this.#leaseTimer = this.#hostWindow.setTimeout(
      () => {
        this.#leaseTimer = undefined;
        void this.#ensureCurrent().catch((error: unknown) => {
          this.#fail(decodeTerminalFailure(error));
        });
      },
      Math.max(0, expiresAt - Date.now()),
    );
  }

  #fail(message: string): void {
    this.#shutdown(new Error(message));
  }

  #shutdown(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectInformation?.(
      error ?? new Error("Computer terminal is closed"),
    );
    this.#rejectInformation = undefined;
    this.#resolveInformation = undefined;
    if (error !== undefined) {
      this.#outputDone = true;
      this.#outputController?.error(error);
      this.#inputController?.error(error);
    } else if (!this.#outputDone) {
      this.#outputDone = true;
      this.#outputController?.close();
    }
    this.#controller.abort();
    this.#mountSignal?.removeEventListener("abort", this.#abort);
    if (this.#retryTimer !== undefined)
      this.#hostWindow.clearTimeout(this.#retryTimer);
    if (this.#leaseTimer !== undefined)
      this.#hostWindow.clearTimeout(this.#leaseTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#release(this);
  }
}
