/**
 * Standalone Oyster's Computer egress: the same host policy Hub's
 * ComputerEgress decides with. It serves three lanes:
 *
 * - Oyster's own origin Git, carrying only the guest's own credential;
 * - the anonymous public download lane (package registries and release hosts
 *   the policy classifies), so a build can install its dependencies, behind
 *   the same `COMPUTER_PUBLIC_EGRESS=disabled` kill switch as Hub;
 * - the internal build hosts: a live App build job's read-only clone on
 *   `git.team.internal` (an installation repository through the Git door,
 *   presented with a host-held job pass the guest never sees, or the App's
 *   template through the registry's read-only template exchange), and its
 *   `/jobs/:id/*` reports and object uploads on `build.team.internal`, each
 *   object streamed into the Release store without passing the registry.
 *
 * Team Git is refused, because this host serves no such lane.
 */
import {
  anonymousRequest,
  anonymousResponse,
  computerEgressDenied,
  decideComputerEgress,
  decidePublicLane,
  originGitRequest,
  publicEgressEnabled,
  recordComputerEgress,
} from "@fungi.computer/computer/egress";
import { createBuildEgress, type BuildGitEvent } from "../build-egress.js";
import type {
  CandidateObject,
  CandidateObjectMediaType,
  TeamAppCandidateManifest,
} from "../build-contract.js";
import { oysterBuildGitHost, oysterBuildReportHost } from "../app-builds.js";
import { gitDoorRoute, smartHttpExchange, type GitDoorTarget } from "../git.js";

/** Loopback props the ComputerDO sets; a guest cannot choose them. */
export type OysterComputerEgressProps = Readonly<{ computerObjectId: string }>;

/** The registry's build admission, for the one Computer this egress serves. */
export type OysterComputerBuildPort = Readonly<{
  gitPassFor(target: GitDoorTarget): Promise<string | null>;
  /** One read-only exchange with a template repository a live job names. */
  exchangeTemplate(repository: string, request: Request): Promise<Response>;
  admitBuild(jobId: string): Promise<Readonly<{ credentialId: string }> | null>;
  /** One object upload for a live job's grant, and its size bound. */
  admitObject(
    jobId: string,
    grant: string,
  ): Promise<Readonly<{ maxObjectBytes: number }> | null>;
  /** Stream one admitted object into the host's Release store. */
  storeObject(
    object: CandidateObject,
    body: ReadableStream<Uint8Array> | null,
    mediaType: CandidateObjectMediaType,
  ): Promise<"stored" | "refused">;
  submitCandidate(
    jobId: string,
    manifest: TeamAppCandidateManifest,
    grant: string,
    credentialId: string,
  ): Promise<Response>;
  record(event: BuildGitEvent): Promise<void>;
}>;

const templateRoute =
  /^\/([a-zA-Z0-9._-]{1,128}?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u;

/**
 * Admit one intercepted guest request. Oyster Git (on `origin`, or a build
 * clone on the internal Git host) is handed to `forward`, the Oyster
 * Worker's own fetch, whose door authenticates it as for any other client.
 */
export async function serveOysterComputerEgress(
  request: Request,
  options: Readonly<{
    origin: string;
    computerId: string;
    /** `COMPUTER_PUBLIC_EGRESS`; only `disabled` closes the public lane. */
    publicEgress: string | undefined;
    build: OysterComputerBuildPort;
    forward(request: Request): Promise<Response>;
  }>,
): Promise<Response> {
  const deny = (host: string, decision: string) =>
    computerEgressDenied({
      computerId: options.computerId,
      teamId: null,
      host,
      method: request.method,
      status: 403,
      decision,
    });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return deny("invalid", "invalid-url");
  }
  const decision = decideComputerEgress(request, url, {
    origin: options.origin,
    route: (request, url) => gitDoorRoute(request.method, url),
  });
  if (decision.kind === "denied") return deny(url.hostname, decision.reason);
  let response: Response;
  if (decision.kind === "origin-git")
    response = await options.forward(originGitRequest(request, url));
  else if (decision.kind === "public") {
    const lane = decidePublicLane({
      publicEgressEnabled: publicEgressEnabled(options.publicEgress),
      teamDisabled: false,
      computerInternetAccessEnabled: true,
    });
    if (lane.kind === "denied") return deny(url.hostname, lane.reason);
    response = anonymousResponse(await fetch(anonymousRequest(request, url)));
  } else if (
    decision.kind === "internal-git" &&
    url.hostname === oysterBuildReportHost
  )
    response = await createBuildEgress({
      admitBuild: (jobId) => options.build.admitBuild(jobId),
      admitObject: (jobId, grant) => options.build.admitObject(jobId, grant),
      storeObject: (object, body, mediaType) =>
        options.build.storeObject(object, body, mediaType),
      submitCandidate: (jobId, manifest, grant, credentialId) =>
        options.build.submitCandidate(jobId, manifest, grant, credentialId),
      record: (event) => options.build.record(event),
    }).fetch(request, url);
  else if (
    decision.kind === "internal-git" &&
    url.hostname === oysterBuildGitHost
  ) {
    const target = gitDoorRoute(request.method, url);
    const template = target === null ? templateRoute.exec(url.pathname) : null;
    if (template !== null) {
      const [, repository = "", suffix = ""] = template;
      if (
        smartHttpExchange(request.method, url, suffix)?.scope !== "read" ||
        url.username ||
        url.password
      )
        return deny(url.hostname, "build-git-route");
      response = await options.build.exchangeTemplate(repository, request);
      if (response.status === 403) return deny(url.hostname, "no-live-build");
    } else {
      if (target?.scope !== "read")
        return deny(url.hostname, "build-git-route");
      const pass = await options.build.gitPassFor(target);
      if (pass === null) return deny(url.hostname, "no-live-build");
      const forwarded = originGitRequest(
        request,
        new URL(url.pathname + url.search, options.origin),
      );
      forwarded.headers.set("Authorization", `Bearer ${pass}`);
      response = await options.forward(forwarded);
    }
  } else return deny(url.hostname, `lane-not-offered:${decision.kind}`);
  recordComputerEgress({
    event: "computer.egress",
    computerId: options.computerId,
    teamId: null,
    lane: decision.kind,
    host: url.hostname,
    method: request.method,
    status: response.status,
    decision: response.status < 400 ? "allowed" : "denied",
    contentLength: response.headers.get("content-length"),
  });
  return response;
}
