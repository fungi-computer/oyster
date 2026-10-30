/** Smart-HTTP routing; all writes enter the same admitted Git path. */
import { z } from "zod";
import type { GitWriter } from "@fungi.computer/agar/git";
import type { AdmittedGit } from "./git-admission.js";

/** The repository and access one smart-HTTP request names. */
export type GitDoorTarget = Readonly<{
  installationId: string;
  repository: string;
  scope: "read" | "write";
}>;
/** Identity and selected installation come only from host-held ports. */
export type GitDoorHost = Readonly<{
  /** Resolve a host-authenticated actor for this exact repository and scope;
   * null refuses the request. */
  authenticate(
    request: Request,
    target: GitDoorTarget,
  ): Promise<Extract<GitWriter, { kind: "actor" }> | null>;
  /** Resolve the installation's admitted path without exposing provider credentials. */
  git(installationId: string): Promise<AdmittedGit | null>;
}>;
const route =
  /^\/git\/([a-zA-Z0-9_-]{1,256})\/([a-zA-Z0-9._-]{1,128}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/u;
/** One smart-HTTP exchange: the method, `service` query and path suffix a
 * Git client sends, whatever path names the repository. Null otherwise. */
export function smartHttpExchange(
  method: string,
  url: URL,
  suffix: string,
): Readonly<{ scope: "read" | "write"; advertise: boolean }> | null {
  const advertise = suffix === "info/refs";
  const service = advertise ? url.searchParams.get("service") : suffix;
  if (
    (service !== "git-upload-pack" && service !== "git-receive-pack") ||
    method !== (advertise ? "GET" : "POST") ||
    (advertise ? url.search !== `?service=${service}` : url.search !== "")
  )
    return null;
  return {
    scope: service === "git-receive-pack" ? "write" : "read",
    advertise,
  };
}
/** Oyster's own Git address: the repository, scope and phase one request
 * names, or null when it is not an exact Oyster Git exchange. */
export function gitDoorRoute(
  method: string,
  url: URL,
): (GitDoorTarget & Readonly<{ advertise: boolean }>) | null {
  const match = route.exec(url.pathname);
  if (match === null) return null;
  const [, installationId = "", repository = "", suffix = ""] = match;
  const exchange = smartHttpExchange(method, url, suffix);
  return exchange === null ? null : { installationId, repository, ...exchange };
}
const MAX_BYTES = 64 * 1024 * 1024;
const byteChunk = z.instanceof(Uint8Array);
async function bodyOf(request: Request): Promise<Uint8Array | Response> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = byteChunk.parse(next.value);
      size += chunk.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return new Response("Git request too large", { status: 413 });
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}
/** One smart-HTTP exchange's answer; the host declares the route it serves at. */
export type GitDoor = Readonly<{
  /** Answer one smart-HTTP request at `/git/...`; anything else is 404. */
  fetch: (request: Request) => Promise<Response>;
}>;

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
  });

/** One smart-HTTP door with no provider credentials or alternate write branch. */
export function createGitDoor(host: GitDoorHost): GitDoor {
  const smartHttp = async (incoming: Request) => {
    const routed = gitDoorRoute(incoming.method, new URL(incoming.url));
    if (routed === null) return text("Not a git route", 404);
    const { advertise, ...target } = routed;
    const { installationId, repository } = target;
    const writing = target.scope === "write";
    const writer = await host.authenticate(incoming, target);
    if (writer === null)
      return new Response("A key is required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Oyster git"' },
      });
    const git = await host.git(installationId);
    if (git === null) return text("Installation Git unavailable", 403);
    if (incoming.headers.get("content-encoding") !== null)
      return text("Compressed Git requests are not supported", 400);
    const body = advertise ? null : await bodyOf(incoming);
    if (body instanceof Response) return body;
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "accept", "git-protocol"]) {
      const value = incoming.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const request = {
      service: writing ? ("receive-pack" as const) : ("upload-pack" as const),
      phase: advertise ? ("advertise" as const) : ("exchange" as const),
      headers,
      body,
    };
    const response = writing
      ? await git.push(writer, repository, request)
      : await git.read(writer, repository, request);
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };
  return { fetch: smartHttp };
}
