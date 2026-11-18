/**
 * Standalone Oyster's Computer egress: the same host policy Hub's
 * ComputerEgress decides with. It serves four lanes:
 *
 * - the Vault lane: a request presenting one of this Computer's live `fvr1.`
 *   references, which the Agent directory that owns the secret completes
 *   (its grant, exact binding, value placement, echo check and audit);
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
  vaultRefusalStatus,
  vaultRequestData,
  type VaultRequestData,
} from "@fungi.computer/computer/egress";
import type { VaultReferenceAdmission } from "@fungi.computer/computer";
import { connectionBodyLimit } from "@fungi.computer/veil/connections";
import { createBuildEgress, type BuildGitEvent } from "../build-egress.js";
import type { ContentObjectOwner } from "../build/content-objects.js";
import type {
  CandidateObject,
  CandidateObjectMediaType,
  TeamAppCandidateManifest,
} from "../build-contract.js";
import { oysterBuildGitHost, oysterBuildReportHost } from "../app-builds.js";
import { gitDoorRoute, smartHttpExchange, type GitDoorTarget } from "../git.js";

/** Loopback props the ComputerDO sets; a guest cannot choose them. */
export type OysterComputerEgressProps = Readonly<{ computerObjectId: string }>;

/** The Vault lane: this Computer resolves a reference, its owner sends. */
export type OysterComputerVaultPort = Readonly<{
  admit(reference: string): Promise<VaultReferenceAdmission | null>;
  send(
    admission: VaultReferenceAdmission,
    data: VaultRequestData,
  ): Promise<Response | Readonly<{ error: string }>>;
}>;

/** The registry's build admission, for the one Computer this egress serves. */
export type OysterComputerBuildPort = Readonly<{
  gitPassFor(target: GitDoorTarget): Promise<string | null>;
  /** One read-only exchange with a template repository a live job names. */
  exchangeTemplate(repository: string, request: Request): Promise<Response>;
  admitBuild(jobId: string): Promise<Readonly<{ credentialId: string }> | null>;
  /** One object upload for a live job's grant, its size bound and owner. */
  admitObject(
    jobId: string,
    grant: string,
  ): Promise<Readonly<{
    maxObjectBytes: number;
    owner: ContentObjectOwner;
  }> | null>;
  /** Stream one admitted object into the host's Release store, in its owner's namespace. */
  storeObject(
    object: CandidateObject,
    body: ReadableStream<Uint8Array> | null,
    mediaType: CandidateObjectMediaType,
    owner: ContentObjectOwner,
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
    /** Live setting from the Computer identified by the host's loopback props. */
    internetAccess(): Promise<boolean>;
    build: OysterComputerBuildPort;
    /** Absent: this host offers no Vault lane, and every reference is refused. */
    vault?: OysterComputerVaultPort;
    forward(request: Request): Promise<Response>;
  }>,
): Promise<Response> {
  const deny = (host: string, decision: string, status = 403) =>
    computerEgressDenied({
      computerId: options.computerId,
      teamId: null,
      host,
      method: request.method,
      status,
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
  if (decision.kind === "vault") {
    if (options.vault === undefined)
      return deny(url.hostname, "lane-not-offered:vault");
    const admission = await options.vault.admit(decision.reference);
    if (admission === null) return deny(url.hostname, "vault-reference");
    const prepared = await vaultRequestData(
      request,
      url,
      decision.reference,
      connectionBodyLimit,
    );
    if (prepared.kind === "refused")
      return deny(
        url.hostname,
        `vault-${prepared.reason}`,
        prepared.reason === "too_large" ? 413 : 403,
      );
    const sent = await options.vault.send(admission, prepared.data);
    if (!(sent instanceof Response))
      return deny(
        url.hostname,
        `vault-${sent.error}`,
        vaultRefusalStatus(sent.error),
      );
    response = sent;
  } else if (decision.kind === "origin-git")
    response = await options.forward(originGitRequest(request, url));
  else if (decision.kind === "public") {
    let enabled: boolean;
    let globalEnabled: boolean;
    try {
      globalEnabled = publicEgressEnabled(options.publicEgress);
      enabled = globalEnabled ? await options.internetAccess() : true;
    } catch {
      return deny(url.hostname, "policy-unavailable", 503);
    }
    const lane = decidePublicLane({
      publicEgressEnabled: globalEnabled,
      teamDisabled: false,
      computerInternetAccessEnabled: enabled,
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
      storeObject: (object, body, mediaType, admitted) =>
        options.build.storeObject(object, body, mediaType, admitted.owner),
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
