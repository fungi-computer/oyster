import { setTimeout as sleep } from "node:timers/promises";
import { addAbortListener } from "node:events";
import type { Release } from "@fungi.computer/puffball";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { instanceRefusalBody } from "./instance-refusal.js";
import {
  installationOperationSchema,
  installationCommandIds,
  type InstallationOperation,
} from "./installation-operations.js";

export type InstallationCompletion = Exclude<
  InstallationOperation,
  { state: "pending" }
>;
/**
 * Installer-owned observer budget, matching the standalone installer's existing
 * twenty-minute default. Not an App grant lifetime or a server execution limit.
 */
const DEFAULT_INSTALLATION_WAIT_MS = 20 * 60_000;
export type InstallationObservationBudget = Readonly<{
  /** Upload/observation time; expiry never cancels admitted durable work. */
  waitMs?: number;
  /** Caller-owned budget; used unchanged unless waitMs is also explicit. */
  signal?: AbortSignal;
}>;
/** Share one budget across pack uploads and the subsequent receipt observation. */
export function installationObservationSignal(
  input: InstallationObservationBudget,
): AbortSignal {
  if (input.signal !== undefined && input.waitMs === undefined)
    return input.signal;
  const timer = AbortSignal.timeout(
    input.waitMs ?? DEFAULT_INSTALLATION_WAIT_MS,
  );
  return input.signal === undefined
    ? timer
    : AbortSignal.any([input.signal, timer]);
}
/** Observer failure supplies no installation outcome and never cancels its owner. */
export class InstallationObservationError extends Error {
  constructor(
    readonly requestId: string,
    options?: ErrorOptions,
  ) {
    super(`Installation outcome unconfirmed (${requestId})`, options);
  }
}

const idle = (ms: number, signal: AbortSignal) =>
  sleep(ms, undefined, { signal });

/** Observe one retained command, over either HTTP or the host's decoded port. */
export async function observeInstallation(
  input: Readonly<{
    requestId: string;
    initial: InstallationOperation | null;
    read(): Promise<InstallationOperation | null>;
    signal: AbortSignal;
    pollMs?: number;
    idle?: (ms: number, signal: AbortSignal) => Promise<void>;
  }>,
): Promise<InstallationCompletion> {
  try {
    input.signal.throwIfAborted();
    let operation = input.initial;
    while (operation === null || operation.state === "pending") {
      input.signal.throwIfAborted();
      // The decoded RPC port has no cancellation argument. Stop THIS wait
      // without cancelling the retained command or abandoning its late reply.
      let listener: ReturnType<typeof addAbortListener> | undefined;
      try {
        operation = await new Promise<InstallationOperation | null>(
          (resolve, reject) => {
            listener = addAbortListener(input.signal, () => {
              reject(
                new InstallationObservationError(input.requestId, {
                  cause: input.signal.reason,
                }),
              );
            });
            // Both late outcomes remain handled after the observer has left.
            Promise.resolve()
              .then(() => input.read())
              .then(resolve, reject);
          },
        );
      } finally {
        listener?.[Symbol.dispose]();
      }
      input.signal.throwIfAborted();
      if (operation === null || operation.state === "pending")
        await (input.idle ?? idle)(input.pollMs ?? 5_000, input.signal);
    }
    return operation;
  } catch (cause) {
    if (cause instanceof InstallationObservationError) throw cause;
    throw new InstallationObservationError(input.requestId, { cause });
  }
}

/** Completed HTTP meaning shared by pack and the retained PUT selection door. */
export function completedInstallationResponse(
  operation: InstallationCompletion,
): Response {
  if (operation.state === "unconfirmed")
    throw new InstallationObservationError(operation.requestId);
  if (operation.state === "refused")
    return Response.json(instanceRefusalBody(operation.code), {
      status: operation.status,
    });
  if (operation.installation === null)
    return Response.json(
      {
        error: "installation_result_unavailable",
        requestId: operation.requestId,
        reference: operation.reference,
      },
      { status: 409 },
    );
  return Response.json(operation.installation, {
    status: operation.creation === "replacement" ? 200 : 201,
  });
}

/**
 * Submit once and observe the correlated owner receipt. Both CLI paths use
 * exactly this contract; no directory reads or old completed-POST branch.
 */
export async function installOnOyster(
  input: Readonly<{
    url: string;
    key: string;
    installationId: string;
    release: Release;
    pollMs?: number;
    idle?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Once, after the owner supplies a correlated record, even after a lost ack. */
    onAdmitted?: (operation: InstallationOperation) => void;
  }> &
    InstallationObservationBudget,
): Promise<InstallationCompletion> {
  const requestId = installationCommandIds.request.generate();
  const signal = installationObservationSignal(input);
  const headers = {
    Authorization: `Bearer ${input.key}`,
    Accept: "application/json",
  };
  let admitted = false;
  const decode = async (response: Response) => {
    const operation = installationOperationSchema.parse(await response.json());
    if (
      operation.requestId !== requestId ||
      operation.requestedInstallationId !== input.installationId ||
      operation.release.appId !== input.release.appId ||
      operation.release.releaseId !== input.release.releaseId ||
      operation.release.artifact.artifactDigest !==
        input.release.artifact.artifactDigest ||
      (operation.state === "succeeded" &&
        operation.installation !== null &&
        (operation.installation.installationId !== operation.installationId ||
          operation.installation.appId !== input.release.appId ||
          operation.installation.release.releaseId !==
            input.release.releaseId ||
          operation.installation.release.artifact.artifactDigest !==
            input.release.artifact.artifactDigest))
    )
      throw new InstallationObservationError(requestId);
    if (!admitted) {
      admitted = true;
      input.onAdmitted?.(operation);
    }
    return operation;
  };
  try {
    signal.throwIfAborted();
    let operation: InstallationOperation | null = null;
    // Catch only the transport, not a malformed authoritative acknowledgement.
    let submitted: Response | null;
    try {
      submitted = await fetch(new URL("/api/installations", input.url), {
        method: "POST",
        signal,
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({
          installationId: input.installationId,
          release: Schema.encodeUnknownSync(releaseSchema)(input.release),
        }),
      });
    } catch {
      signal.throwIfAborted();
      submitted = null;
      // Missing acknowledgement is not permission to resubmit.
    }
    if (submitted?.status === 202) operation = await decode(submitted);
    else if (submitted !== null && submitted.status < 500)
      throw new InstallationObservationError(requestId);
    const statusUrl = new URL(
      `/api/installations/${encodeURIComponent(input.installationId)}/status`,
      input.url,
    );
    statusUrl.searchParams.set("requestId", requestId);
    let observation: Parameters<typeof observeInstallation>[0] = {
      requestId,
      initial: operation,
      signal,
      read: async () => {
        // Like decoded RPC reads, transport errors reach the observer with
        // their original cause; they are not an authoritative pending read.
        const observed = await fetch(statusUrl, { headers, signal });
        if (observed.status === 200) return decode(observed);
        if (observed.status !== 404 && observed.status < 500)
          throw new InstallationObservationError(requestId);
        return null;
      },
    };
    if (input.pollMs !== undefined)
      observation = { ...observation, pollMs: input.pollMs };
    if (input.idle !== undefined)
      observation = { ...observation, idle: input.idle };
    return await observeInstallation(observation);
  } catch (cause) {
    if (cause instanceof InstallationObservationError) throw cause;
    throw new InstallationObservationError(requestId, { cause });
  }
}
