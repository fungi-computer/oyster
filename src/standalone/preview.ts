import * as Schema from "effect/Schema";
import * as z from "zod";
import {
  ComputerPortAccess,
  PortAccessError,
} from "@fungi.computer/computer/port-access";
import { selectionSchema } from "../index.js";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import { computerPortInputSchema } from "@fungi.computer/computer-contract";
import { owner, publicRoute, routes } from "../authorization.js";
import { html } from "hono/html";
import type { OysterEnv } from "../host.js";

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
  const { getDomain } = await import("tldts");
  const site = (url: URL) =>
    getDomain(url.hostname, { allowPrivateDomains: true });
  const ownerSite = site(owner.data);
  const previewSite = site(configured.preview);
  if (ownerSite === null || previewSite === null || ownerSite === previewSite)
    return null;
  return {
    owner: owner.data.origin,
    preview: configured.preview.origin,
  };
}

export class PreviewRefused extends Error {}

// Public suffix rules only: a private-suffix preview domain still makes every
// workspace-* host one site, so the gate refuses siblings that browsers might
// treat as separate sites. Loaded on demand like previewOrigins' parser.
async function publicSite() {
  const { getDomain } = await import("tldts");
  return (url: URL) => getDomain(url.hostname, { allowPrivateDomains: false });
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
    throw new PreviewRefused();
  const label = `${computerId.replace("computer_", "computer-")}-${String(port)}`;
  if (label.length > 63) throw new PreviewRefused();
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
  const access = new ComputerPortAccess(storage);
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
        site: await publicSite(),
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

/** Establish a top-level same-site document before the owner's Strict-cookie POST. */
export function standalonePortEntryRoutes(
  ports: Readonly<{
    ownsComputer: (computerId: string) => Promise<boolean>;
    issue: (
      computerId: string,
      ownerId: string,
      port: number,
    ) => Promise<{ previewUrl: string } | null>;
  }>,
) {
  const path = "/computers/:computerId/ports/:port";
  return routes<OysterEnv>()
    .get(
      path,
      publicRoute(
        "a preview entry document; only the owner-admitted POST issues a token",
      ),
      (context) => {
        context.header("Cache-Control", "no-store");
        context.header("Referrer-Policy", "no-referrer");
        context.header("Cross-Origin-Opener-Policy", "same-origin");
        // Chromium applies form-action to the POST redirect as well. The fixed
        // same-origin form must be able to finish on the HTTPS preview site.
        context.header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; form-action https:; frame-ancestors 'none'; base-uri 'none'",
        );
        return context.html(
          html`<!doctype html><title>Open preview</title>
            <main>
              <form method="post" action="${context.req.path}">
                <button>Open preview</button>
              </form>
              <script>
                document.forms[0].requestSubmit();
              </script>
            </main>`,
        );
      },
    )
    .post(path, owner("direct"), async (context, { principal }) => {
      const computerId = context.req.param("computerId");
      const portParam = context.req.param("port");
      const port = computerPortInputSchema.safeParse({
        port: Number(portParam),
      });
      if (
        !/^[1-9][0-9]{0,4}$/u.test(portParam) ||
        !port.success ||
        !(await ports.ownsComputer(computerId))
      )
        return context.body(null, 404);
      try {
        const issued = await ports.issue(
          computerId,
          principal.actor.memberId,
          port.data.port,
        );
        if (issued === null) return context.body(null, 404);
        context.header("Cache-Control", "no-store");
        context.header("Referrer-Policy", "no-referrer");
        return context.redirect(issued.previewUrl, 302);
      } catch (cause) {
        if (cause instanceof PreviewRefused || cause instanceof PortAccessError)
          return context.body(null, 404);
        throw cause;
      }
    });
}
