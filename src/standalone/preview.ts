import * as Schema from "effect/Schema";
import * as z from "zod";
import { ComputerPortAccess } from "@fungi.computer/computer/port-access";
import { selectionSchema } from "../index.js";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import { computerPortInputSchema } from "@fungi.computer/computer-contract";
import { owner, routes } from "../authorization.js";
import type { OysterEnv } from "../host.js";
import { sameOriginRequest } from "../request-origin.js";
import {
  parsePortPreviewPort,
  portPreviewIssueSchema,
  portPreviewRefusalMessage,
  portPreviewRefusalStatus,
  type PortPreviewIssue,
  type PortPreviewIssueRefusal,
  type PortPreviewRefusal,
} from "../port-preview-entry.js";

export const previewSelectorSchema = Schema.Struct({
  ownerId: Schema.NonEmptyString,
  installationId: Schema.NonEmptyString,
  selection: selectionSchema,
  artifactDigest: sha256DigestSchema,
});
export type PreviewSelector = Schema.Schema.Type<typeof previewSelectorSchema>;
export type PreviewOrigins = Readonly<{
  owner: string;
  preview: string;
}>;
export type StandalonePreviewEnv = Readonly<{
  OYSTER_ORIGIN?: string;
  /** Retired shared origin: recognized only to refuse traffic, never serve it. */
  OYSTER_PREVIEW_ORIGIN?: string;
  /** Bare domain with wildcard TLS and routing supplied by the operator. */
  OYSTER_PREVIEW_DOMAIN?: string;
}>;
const originSchema = z.lazy(() =>
  z
    .url()
    .transform((input) => new URL(input))
    .refine(
      (url) =>
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash,
    ),
);

/**
 * The one registrable-site rule for configuration and the port gate. Private
 * PSL entries (workers.dev, ...) are included because browsers use them for
 * SameSite cookies. Loaded on demand to keep the idle heap budget.
 */
async function registrableSite(): Promise<(url: URL) => string | null> {
  const { getDomain } = await import("tldts");
  return (url) => getDomain(url.hostname, { allowPrivateDomains: true });
}

function configuredPreview(env: StandalonePreviewEnv) {
  if (env.OYSTER_PREVIEW_DOMAIN !== undefined) {
    const parsed = originSchema.safeParse(
      `https://${env.OYSTER_PREVIEW_DOMAIN}`,
    );
    return parsed.success &&
      parsed.data.hostname === env.OYSTER_PREVIEW_DOMAIN &&
      !parsed.data.port
      ? { preview: parsed.data, mode: "host" as const }
      : null;
  }
  const parsed = originSchema.safeParse(env.OYSTER_PREVIEW_ORIGIN);
  return parsed.success
    ? { preview: parsed.data, mode: "path" as const }
    : null;
}
export async function previewOrigins(
  env: StandalonePreviewEnv,
): Promise<PreviewOrigins | null> {
  const owner = originSchema.safeParse(env.OYSTER_ORIGIN);
  const configured = configuredPreview(env);
  if (!owner.success || configured?.mode !== "host") return null;
  const site = await registrableSite();
  const ownerSite = site(owner.data);
  const previewSite = site(configured.preview);
  if (ownerSite === null || previewSite === null || ownerSite === previewSite)
    return null;
  return {
    owner: owner.data.origin,
    preview: configured.preview.origin,
  };
}

export class PreviewRefused extends Error {
  constructor(readonly reason: PortPreviewIssueRefusal) {
    super(`Port preview ${reason}`);
  }
}

// The retained flat hostname uses the Computer's non-secret identity. Fleet
// IDs have a computer_ prefix; configured standalone IDs can be simple labels.
const hostnameComputer = z.string().regex(/^(?:computer_)?[a-z0-9]+$/u);
function previewUrl(
  origins: PreviewOrigins,
  computerId: string,
  port: number,
): URL {
  if (!hostnameComputer.safeParse(computerId).success)
    throw new PreviewRefused("invalid_computer_address");
  const label = `${computerId.replace("computer_", "computer-")}-${String(port)}`;
  if (label.length > 63) throw new PreviewRefused("invalid_computer_address");
  const result = new URL(origins.preview);
  result.hostname = `${label}.${result.hostname}`;
  return result;
}
function entryUrl(
  origins: PreviewOrigins,
  computerId: string,
  port: number,
): string {
  return new URL(
    `/computers/${encodeURIComponent(computerId)}/ports/${String(port)}`,
    origins.owner,
  ).href;
}
export type PreviewNative = Readonly<{
  accept: (ownerId: string) => void;
  /** Whether this member ID is still the Oyster's owner. */
  isOwner: (ownerId: string) => Promise<boolean>;
  forward: (
    port: number,
    request: Request,
    accept: () => void,
  ) => Promise<Response>;
}>;

export function createStandalonePreview(
  storage: ConstructorParameters<typeof ComputerPortAccess>[0],
  computerId: string,
  origins: PreviewOrigins,
  native: PreviewNative,
) {
  // A preview session names the owner who opened it; it ends when that
  // member is no longer the owner.
  const access = new ComputerPortAccess(storage, {
    admitted: (principal) =>
      "ownerId" in principal
        ? native.isOwner(principal.ownerId)
        : Promise.resolve(false),
  });
  const issueOwner = async (ownerId: string, port: number) => {
    const target = previewUrl(origins, computerId, port);
    const token = await access.issue(port, { ownerId }, () => {
      native.accept(ownerId);
    });
    target.searchParams.set("token", token);
    return { previewUrl: target.href };
  };
  return {
    issueOwner,
    entry(port: number) {
      return entryUrl(origins, computerId, port);
    },
    async fetch(port: number, request: Request): Promise<Response> {
      const target = previewUrl(origins, computerId, port);
      const incoming = new URL(request.url);
      if (
        incoming.origin !== target.origin ||
        !incoming.pathname.startsWith(target.pathname)
      )
        return new Response(null, { status: 404 });
      const policy = {
        entryUrl: entryUrl(origins, computerId, port),
        site: await registrableSite(),
      };
      return access
        .gate(port, policy, async (admitted) => {
          const service = new URL("http://localhost");
          service.pathname = incoming.pathname;
          service.search = incoming.search;
          const headers = new Headers(admitted.headers);
          headers.delete("host");
          return native.forward(
            port,
            new Request(service, new Request(admitted, { headers })),
            () => undefined,
          );
        })
        .fetch(request);
    },
  };
}

export async function standalonePreviewRequest(
  request: Request,
  env: StandalonePreviewEnv,
  ownsComputer: (computerId: string) => Promise<boolean>,
  forward: (
    computerId: string,
    port: number,
    request: Request,
  ) => Promise<Response>,
): Promise<Response | null> {
  const incoming = new URL(request.url);
  const configured = configuredPreview(env);
  if (configured === null) return null;
  const matches =
    configured.mode === "path"
      ? incoming.origin === configured.preview.origin
      : incoming.hostname === configured.preview.hostname ||
        incoming.hostname.endsWith(`.${configured.preview.hostname}`);
  if (!matches) return null;
  const origins = await previewOrigins(env);
  if (
    origins === null ||
    incoming.protocol !== "https:" ||
    incoming.port !== configured.preview.port
  )
    return new Response(null, { status: 404 });
  const pattern = new URLPattern({
    hostname: `:computerId-:port([0-9]{1,5}).${configured.preview.hostname}`,
  }).exec(incoming)?.hostname.groups;
  if (pattern === undefined) return new Response(null, { status: 404 });
  const parsed = z
    .object({
      computerId: z.string().min(1).max(768),
      port: z.string().regex(/^[1-9][0-9]{0,4}$/u),
    })
    .safeParse(pattern);
  if (!parsed.success) return new Response(null, { status: 404 });
  const computerId = parsed.data.computerId.replace(/^computer-/u, "computer_");
  const port = computerPortInputSchema.safeParse({
    port: Number(parsed.data.port),
  });
  if (!port.success || computerId.length > 256)
    return new Response(null, { status: 404 });
  if (!(await ownsComputer(computerId)))
    return new Response(null, { status: 404 });
  return forward(computerId, port.data.port, request);
}

/**
 * Issue a private port preview from the owner's own click on the host's
 * confirm page (`OysterHost.portPreviewEntry`), never from a submit no person
 * made.
 */
export function standalonePortEntryRoutes(
  ports: Readonly<{
    ownsComputer: (computerId: string) => Promise<boolean>;
    issue: (
      computerId: string,
      ownerId: string,
      port: number,
    ) => Promise<PortPreviewIssue>;
  }>,
) {
  const path = "/computers/:computerId/ports/:port";
  return routes<OysterEnv>().post(
    path,
    owner("direct"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const refuse = (reason: PortPreviewRefusal) =>
        context.json(
          { error: reason, message: portPreviewRefusalMessage(reason) },
          portPreviewRefusalStatus[reason],
        );
      // Activation alone does not prove origin: a clicked sibling-site form
      // can carry both user activation and the owner's Strict cookie.
      if (!sameOriginRequest(context.req.raw))
        return refuse("same_origin_required");
      // Require a user-activated navigation, never an automatic entry submit.
      if (context.req.header("Sec-Fetch-User") !== "?1")
        return refuse("confirmation_required");
      const computerId = context.req.param("computerId");
      const portParam = context.req.param("port");
      const port = parsePortPreviewPort(portParam);
      if (port === undefined) return refuse("invalid_port");
      if (!(await ports.ownsComputer(computerId)))
        return refuse("computer_not_found");
      const issued = portPreviewIssueSchema.parse(
        await ports.issue(computerId, principal.actor.memberId, port),
      );
      if (issued.kind === "refused") return refuse(issued.reason);
      context.header("Referrer-Policy", "no-referrer");
      return context.redirect(issued.previewUrl, 302);
    },
  );
}
