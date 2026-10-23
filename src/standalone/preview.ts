import * as Schema from "effect/Schema";
import * as z from "zod";
import { ComputerPortPreview } from "@fungi.computer/computer/preview";
import { selectionSchema } from "../index.js";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import { computerPortInputSchema } from "@fungi.computer/computer-contract";

export const previewSelectorSchema = Schema.Struct({
  ownerId: Schema.NonEmptyString,
  installationId: Schema.NonEmptyString,
  selection: selectionSchema,
  artifactDigest: sha256DigestSchema,
});
export type PreviewSelector = Schema.Schema.Type<typeof previewSelectorSchema>;
export type PreviewOrigins = Readonly<{ owner: string; preview: string }>;
export type StandalonePreviewEnv = Readonly<{
  OYSTER_ORIGIN?: string;
  OYSTER_PREVIEW_ORIGIN?: string;
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

export function previewOrigins(
  env: StandalonePreviewEnv,
): PreviewOrigins | null {
  if (env.OYSTER_PREVIEW_ORIGIN === undefined) return null;
  const parsed = z
    .object({ owner: originSchema, preview: originSchema })
    .safeParse({
      owner: env.OYSTER_ORIGIN,
      preview: env.OYSTER_PREVIEW_ORIGIN,
    });
  if (!parsed.success) return null;
  const { owner, preview } = parsed.data;
  // The preview tunnel must be a distinct origin from the canonical owner
  // origin: it carries no cookies and no owner credential, so it cannot be
  // the same origin the owner signs in on. Which two origins those are is a
  // deploy-time choice (this Worker's own custom domain plus its workers.dev
  // address, or any other pair the operator actually controls) — never a
  // literal this module hard-codes.
  if (owner.origin === preview.origin) return null;
  return { owner: owner.origin, preview: preview.origin };
}

/**
 * The configured preview tunnel origin alone, independent of whether the
 * owner origin also validates. Once an operator points OYSTER_PREVIEW_ORIGIN
 * at a host, that host is always treated as preview-only and never falls
 * through to the normal router — even if the rest of the config (the owner
 * origin) is separately broken. Only a host nothing configured as preview
 * is left to the caller's own routing.
 */
function configuredPreviewOrigin(env: StandalonePreviewEnv): string | null {
  const parsed = originSchema.safeParse(env.OYSTER_PREVIEW_ORIGIN);
  return parsed.success ? parsed.data.origin : null;
}

/**
 * The native Computer's preview port. `current` re-proves the selector's
 * owner and Installation against live authority before every issue and
 * every forwarded request.
 */
export type PreviewNative = Readonly<{
  current: (selector: PreviewSelector) => Promise<void>;
  accept: (selector: PreviewSelector) => void;
  list: (accept: () => void) => Promise<{ ports: number[] }>;
  forward: (
    port: number,
    request: Request,
    accept: () => void,
  ) => Promise<Response>;
}>;

export class PreviewRefused extends Error {}

export function createStandalonePreview(
  storage: ConstructorParameters<typeof ComputerPortPreview>[0],
  computerId: string,
  origin: string,
  native: PreviewNative,
) {
  const tickets = new ComputerPortPreview(storage, {
    selector: previewSelectorSchema,
    previewUrl: (signature, base) => `${base}/${signature}/`,
    accept: native.accept,
    listPorts: native.list,
    forward: native.forward,
    portDenied: () => {
      throw new PreviewRefused();
    },
    dispatchFailure: (cause) => {
      if (cause instanceof PreviewRefused)
        return new Response(null, { status: 403 });
      console.error("Standalone preview native dispatch failed", cause);
      return new Response(null, { status: 502 });
    },
    invalidClaims: () => {
      console.error("Standalone preview ticket claims refused");
    },
  });
  return {
    async issue(selector: PreviewSelector, port: number) {
      await native.current(selector);
      return tickets.issueAfterAcceptance(
        selector,
        port,
        `${origin}/preview/${encodeURIComponent(computerId)}/${String(port)}`,
      );
    },
    async fetch(
      signature: string,
      port: number,
      request: Request,
    ): Promise<Response> {
      return tickets.dispatchSigned(
        signature,
        request,
        async (selector, selectedPort, incoming) => {
          if (selectedPort !== port) return new Response(null, { status: 403 });
          try {
            await native.current(selector);
            return await passivePreviewResponse(
              await tickets.dispatch(selector, port, incoming),
            );
          } catch (cause) {
            if (cause instanceof PreviewRefused)
              return new Response(null, { status: 403 });
            console.error(
              "Standalone preview current authority check failed",
              cause,
            );
            return new Response(null, { status: 503 });
          }
        },
      );
    },
  };
}

export async function passivePreviewResponse(
  response: Response,
): Promise<Response> {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.headers.has("Refresh")
  ) {
    await response.body?.cancel();
    return new Response(null, {
      status:
        response.headers.has("Refresh") ||
        (response.status >= 300 && response.status < 400)
          ? 502
          : response.status,
    });
  }
  const contentType = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "text/plain") {
    await response.body?.cancel();
    return new Response(null, { status: 415 });
  }
  const headers = new Headers({
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Security-Policy":
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(response.body, { status: response.status, headers });
}

export async function standalonePreviewRequest(
  request: Request,
  env: StandalonePreviewEnv,
  ownsComputer: (computerId: string) => Promise<boolean>,
  forward: (
    computerId: string,
    signature: string,
    port: number,
    request: Request,
  ) => Promise<Response>,
): Promise<Response | null> {
  const incoming = new URL(request.url);
  const previewHost = configuredPreviewOrigin(env);
  // A host nothing configured as the preview tunnel is left to the caller's
  // own routing, like any other Host this module doesn't recognize.
  if (previewHost === null || incoming.origin !== previewHost) return null;
  // Past this point the Host is the configured preview tunnel: it never
  // falls through to the normal router, even if the rest of the pair (the
  // owner origin) turns out to be broken — the checks below just decide
  // 403/404/503 vs. forwarding.
  if (
    !["GET", "HEAD"].includes(request.method) ||
    request.headers.has("Upgrade")
  )
    return new Response(null, { status: 404 });
  const path = new URLPattern({
    pathname: "/preview/:computerId/:port/:signature/*",
  }).exec(incoming)?.pathname.groups;
  if (path === undefined) return new Response(null, { status: 404 });
  if (previewOrigins(env) === null) return new Response(null, { status: 404 });
  const ticket = z
    .object({
      computerId: z.string().min(1),
      port: z.string().regex(/^[0-9]{1,5}$/u),
      signature: z.string().regex(/^[a-z2-7]{20}$/u),
      "0": z.string(),
    })
    .safeParse(path);
  if (!ticket.success) return new Response(null, { status: 404 });
  let computerId: string;
  try {
    computerId = decodeURIComponent(ticket.data.computerId);
  } catch (cause) {
    if (cause instanceof URIError) return new Response(null, { status: 404 });
    throw cause;
  }
  if (
    computerId.length === 0 ||
    computerId.length > 256 ||
    encodeURIComponent(computerId) !== ticket.data.computerId
  )
    return new Response(null, { status: 404 });
  const input = computerPortInputSchema.safeParse({
    port: Number(ticket.data.port),
  });
  if (!input.success || String(input.data.port) !== ticket.data.port)
    return new Response(null, { status: 404 });
  if (!(await ownsComputer(computerId)))
    return new Response(null, { status: 404 });
  const service = new URL("http://localhost");
  service.pathname = `/${ticket.data["0"]}`;
  service.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of ["cookie", "authorization", "proxy-authorization", "host"])
    headers.delete(name);
  return forward(
    computerId,
    ticket.data.signature,
    input.data.port,
    new Request(service, {
      method: request.method,
      headers,
      signal: request.signal,
    }),
  );
}
