import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  teamAppCandidateManifestSchema,
  TEAM_APP_CANDIDATE_MANIFEST_MAX_BYTES,
  candidateObjectMediaType,
  candidateObjectSchema,
  type CandidateObject,
  type CandidateObjectMediaType,
  type TeamAppCandidateManifest,
} from "./build-contract.js";

/**
 * The Computer's own egress for its build job's `/jobs/:id/*` reports. A
 * live build uploads each built object alone, streamed straight into the
 * host's content-addressed store, then submits the small manifest naming
 * them through Team submission custody, then reports bytes/status. Selection
 * and promotion are never admitted here. The
 * Computer presents no credential of its own: every decision is
 * port-injected so a host (Hub today, Oyster's standalone host once it
 * mounts a Computer build) supplies its own admission, submission and event
 * recording without this module reaching into either host's state.
 */

const statusSchema = z.strictObject({
  status: z.enum(["succeeded", "failed"]),
  detail: z.string().max(2_000).optional(),
});
const artifactSchema = z.strictObject({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

/** The two facts a build job reports; a host's Team Git event is a superset
 * that also carries pushes, so a host's own record callback is always
 * assignable here. */
export type BuildGitEvent =
  | Readonly<{
      kind: "build-artifact";
      jobId: string;
      credentialId: string;
      digest: string;
      bytes: number;
    }>
  | Readonly<{
      kind: "build-status";
      jobId: string;
      credentialId: string;
      status: "succeeded" | "failed";
      detail: string | null;
    }>;

/** A Git principal admitted to read exactly one live build job's one
 * repository: the job-scoped read clone. It never pushes, and its reads are
 * never recorded as Team Git push events. */
export type BuildGitPrincipal = Readonly<{
  kind: "build";
  jobId: string;
  credentialId: string;
}>;

/** True when an admitted Git principal is a build job's job-scoped read
 * credential rather than an Agent or a Workflow Git pass. A host's Git
 * egress uses this to admit the job-scoped read clone while refusing any
 * write and skipping push-event recording for it. Generic so a host's own
 * wider principal union still narrows away the "build" member afterward,
 * exactly as the literal `principal.kind === "build"` comparison it
 * replaces did. */
export function isBuildGitPrincipal<P extends Readonly<{ kind: string }>>(
  principal: P,
): principal is Extract<P, Readonly<{ kind: "build" }>> {
  return principal.kind === "build";
}

/**
 * The build-report handler for `/jobs/:id/(candidate|artifact|status)` and
 * `PUT /jobs/:id/objects/sha256-<hex>`. `admitBuild` is the host's own
 * live-job lookup; `admitObject` admits one object upload for a live job's
 * grant and answers its size bound; `storeObject` streams an admitted object
 * into the host's content-addressed store, which verifies its digest;
 * `submitCandidate` hands an admitted manifest to the host's Publisher
 * custody; `record` delivers a reported fact to the host's own projection.
 * `report` observes a body or JSON decode failure without changing its 400
 * outcome; a host may wire its own structured logger or omit it.
 */
export function createBuildEgress(
  options: Readonly<{
    admitBuild: (
      jobId: string,
    ) => Promise<Readonly<{ credentialId: string }> | null>;
    admitObject: (
      jobId: string,
      grant: string,
    ) => Promise<Readonly<{ maxObjectBytes: number }> | null>;
    storeObject: (
      object: CandidateObject,
      body: ReadableStream<Uint8Array> | null,
      mediaType: CandidateObjectMediaType,
    ) => Promise<"stored" | "refused">;
    submitCandidate: (
      jobId: string,
      manifest: TeamAppCandidateManifest,
      grant: string,
      credentialId: string,
    ) => Promise<Response>;
    record: (event: BuildGitEvent) => Promise<void>;
    report?: (operation: string, cause: unknown) => void;
  }>,
) {
  const report =
    options.report ??
    ((operation: string, cause: unknown) => {
      console.error(operation, cause);
    });
  const putObject = async (
    request: Request,
    jobId: string,
    hex: string,
  ): Promise<Response> => {
    const admitted = await options.admitObject(
      jobId,
      request.headers.get("X-Team-App-Build") ?? "",
    );
    if (admitted === null) return new Response(null, { status: 403 });
    // The stated length bounds what the store takes before a byte moves.
    const length = request.headers.get("Content-Length") ?? "";
    if (!/^(0|[1-9][0-9]{0,14})$/u.test(length))
      return new Response(null, { status: 411 });
    const byteLength = Number(length);
    if (byteLength > admitted.maxObjectBytes) {
      await request.body?.cancel();
      return new Response(null, { status: 413 });
    }
    const mediaType = candidateObjectMediaType(
      request.headers.get("Content-Type"),
    );
    if (mediaType === null) {
      await request.body?.cancel();
      return new Response(null, { status: 415 });
    }
    const stored = await options.storeObject(
      Schema.decodeUnknownSync(candidateObjectSchema)({
        digest: `sha256:${hex}`,
        byteLength,
      }),
      request.body,
      mediaType,
    );
    return new Response(null, { status: stored === "stored" ? 204 : 400 });
  };
  return Object.freeze({
    async fetch(request: Request, url: URL): Promise<Response> {
      if (url.search !== "" || url.username || url.password)
        return new Response(null, { status: 403 });
      const object =
        /^\/jobs\/([a-zA-Z0-9_-]{1,128})\/objects\/sha256-([0-9a-f]{64})$/u.exec(
          url.pathname,
        );
      if (object !== null) {
        const [, jobId = "", hex = ""] = object;
        return request.method === "PUT"
          ? putObject(request, jobId, hex)
          : new Response(null, { status: 403 });
      }
      const match =
        /^\/jobs\/([a-zA-Z0-9_-]{1,128})\/(status|artifact|candidate)$/u.exec(
          url.pathname,
        );
      const jobId = match?.[1];
      const action = match?.[2];
      if (jobId === undefined || request.method !== "POST")
        return new Response(null, { status: 403 });
      const job = await options.admitBuild(jobId);
      if (job === null) return new Response(null, { status: 403 });
      if (action === "candidate") {
        let manifest: TeamAppCandidateManifest;
        try {
          if (request.body === null) return new Response(null, { status: 400 });
          let size = 0;
          const bounded = request.body.pipeThrough(
            new TransformStream({
              transform(chunk: Uint8Array, controller) {
                size += chunk.byteLength;
                if (size > TEAM_APP_CANDIDATE_MANIFEST_MAX_BYTES)
                  throw new Error("candidate manifest oversize");
                controller.enqueue(chunk);
              },
            }),
          );
          manifest = Schema.decodeUnknownSync(teamAppCandidateManifestSchema, {
            onExcessProperty: "error",
          })(await new Response(bounded).json());
        } catch {
          return new Response(null, { status: 400 });
        }
        return options.submitCandidate(
          jobId,
          manifest,
          request.headers.get("X-Team-App-Build") ?? "",
          job.credentialId,
        );
      }
      let json: unknown;
      try {
        json = await request.json();
      } catch (cause) {
        report("packages/oyster/src/build-egress.ts:report", cause);
        return new Response(null, { status: 400 });
      }
      if (action === "artifact") {
        const artifact = artifactSchema.safeParse(json);
        if (!artifact.success) return new Response(null, { status: 400 });
        await options.record({
          kind: "build-artifact",
          jobId,
          credentialId: job.credentialId,
          ...artifact.data,
        });
        return new Response(null, { status: 204 });
      }
      const status = statusSchema.safeParse(json);
      if (!status.success) return new Response(null, { status: 400 });
      await options.record({
        kind: "build-status",
        jobId,
        credentialId: job.credentialId,
        status: status.data.status,
        detail: status.data.detail ?? null,
      });
      return new Response(null, { status: 204 });
    },
  });
}
