import { z } from "zod";

const limitsSchema = z.strictObject({
  bodyBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
  headerBytes: z
    .number()
    .int()
    .positive()
    .max(32 * 1024),
  headerCount: z.number().int().positive().max(128),
  readMilliseconds: z.number().int().positive().max(30_000),
});

/** A private defensive ceiling, not a sender-controlled policy or spend cap. */
export type WebhookIngressLimits = z.output<typeof limitsSchema>;
export type WebhookDelivery = Readonly<{
  bindingId: string;
  headers: Headers;
  body: Uint8Array;
}>;
export type WebhookAdmission =
  | Readonly<{ status: "accepted"; deliveryId: string }>
  | Readonly<{ status: "refused" }>;

const failureResponse = (error: "refused" | "unavailable") =>
  Response.json(
    { error },
    {
      status: error === "refused" ? 403 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
export const workflowWebhookRefusal = () => failureResponse("refused");
const readFailureKind = (cause: unknown) =>
  cause instanceof Error && cause.name === "AbortError"
    ? "aborted"
    : "read_failed";

type ReadFailure = (kind: "aborted" | "read_failed") => void;
type HostAdmission =
  | Readonly<{ status: "admitted"; release: () => void }>
  | Readonly<{ status: "refused" | "unavailable" }>;

function headersWithinLimits(headers: Headers, limits: WebhookIngressLimits) {
  let count = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  headers.forEach((value, key) => {
    count++;
    bytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  });
  return count <= limits.headerCount && bytes <= limits.headerBytes;
}

/** null means the producer exhausted its byte or read-time allowance. */
async function readChunks(
  reader: ReadableStreamDefaultReader<unknown>,
  expired: Promise<null>,
  maximum: number,
) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await Promise.race([reader.read(), expired]);
    if (part === null) return null;
    if (part.done) return chunks;
    const chunk = z.instanceof(Uint8Array).parse(part.value);
    length += chunk.byteLength;
    if (length > maximum) return null;
    chunks.push(chunk);
  }
}

function joinChunks(chunks: readonly Uint8Array[]) {
  const body = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readBoundedBody(
  request: Request,
  limits: WebhookIngressLimits,
  report: ReadFailure,
) {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, limits.readMilliseconds);
  });
  let chunks: Uint8Array[] | null;
  try {
    chunks = await readChunks(reader, expired, limits.bodyBytes);
    if (chunks === null) {
      // Cancellation is not awaited: an untrusted producer can stall it.
      void reader.cancel().catch((cause: unknown) => {
        report(readFailureKind(cause));
      });
    }
  } catch (cause) {
    report(readFailureKind(cause));
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return chunks === null ? null : joinChunks(chunks);
}

/**
 * The public representation boundary. Rate admission and streaming limits run
 * before ANY binding access. The private owner verifies and durably admits;
 * this port cannot read, disclose or choose a key, actor or Computer.
 */
export function workflowWebhookIngress(options: {
  limits: WebhookIngressLimits;
  hostLease(): Promise<null | (() => void)>;
  deliver(delivery: WebhookDelivery): Promise<WebhookAdmission>;
  /** Count a fixed failure category; never log producer-controlled error text. */
  reportReadFailure(kind: "aborted" | "read_failed"): void;
  /** Fixed operational counter only; private owner errors may contain secrets. */
  reportOwnerFailure(): void;
}) {
  const limits = limitsSchema.parse(options.limits);
  const admitHost = async (): Promise<HostAdmission> => {
    try {
      const release = await options.hostLease();
      return release === null
        ? { status: "refused" }
        : { status: "admitted", release };
    } catch {
      options.reportOwnerFailure();
      return { status: "unavailable" };
    }
  };
  const deliver = async (
    delivery: WebhookDelivery,
  ): Promise<WebhookAdmission | Readonly<{ status: "unavailable" }>> => {
    try {
      return await options.deliver(delivery);
    } catch {
      options.reportOwnerFailure();
      return { status: "unavailable" };
    }
  };
  return async (bindingId: string, request: Request): Promise<Response> => {
    const admission = await admitHost();
    if (admission.status !== "admitted")
      return failureResponse(admission.status);
    const { release } = admission;
    try {
      if (request.method !== "POST") return workflowWebhookRefusal();
      if (!headersWithinLimits(request.headers, limits))
        return workflowWebhookRefusal();
      const body = await readBoundedBody(request, limits, (kind) => {
        options.reportReadFailure(kind);
      });
      if (body === null) return workflowWebhookRefusal();
      const outcome = await deliver({
        bindingId,
        headers: request.headers,
        body,
      });
      if (outcome.status !== "accepted") return failureResponse(outcome.status);
      return Response.json(
        { accepted: true, deliveryId: outcome.deliveryId },
        { status: 202, headers: { "cache-control": "no-store" } },
      );
    } finally {
      release();
    }
  };
}
