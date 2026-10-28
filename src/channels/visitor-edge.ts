import { Hono, type Context, type Env as HonoEnv } from "hono";
import { html } from "hono/html";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { z } from "zod";
import { sameOriginReadRequest, sameOriginRequest } from "../request-origin.js";

import { channelIds } from "./ids.js";
import { originAllowed } from "./binding.js";
import type {
  ChannelWithdrawResult,
  IntakeResult,
  VisitorPendingPrompt,
  VisitorReadOptions,
} from "./conversations.js";
import { visitorBearerSchema, type VisitorGrant } from "./visitors.js";
import { visitorRequestSchema } from "./visitor-request.js";
import type { Avatar } from "@fungi.computer/sprite/avatar";

/**
 * The public web-channel edge. The host owns address lookup, visitor identity
 * and Agent selection. Current conversation operations authenticate their
 * bearer before asking the host to resolve an Agent for that visitor. The
 * retained legacy GET /conversation keeps its site-owner path.
 */

const siteKeySchema = z
  .string()
  .refine((value): boolean => channelIds.site.is(value));
const messageSchema = visitorRequestSchema.extend({
  text: z.string().trim().min(1).max(16_000),
});
const refreshSchema = z.strictObject({ refreshSecret: visitorBearerSchema });
const sessionReadSchema = z
  .strictObject({
    limit: z.number().int().min(1).max(200).optional(),
    before: z.string().min(1).max(2048).optional(),
  })
  .transform((value): VisitorReadOptions => {
    if (value.limit === undefined)
      return value.before === undefined ? {} : { before: value.before };
    if (value.before === undefined) return { limit: value.limit };
    return { limit: value.limit, before: value.before };
  });
const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json),
);

/** Public address facts the host supplies after looking up an embed site. */
export type VisitorSiteAddress = Readonly<{ bindingId: string }>;
/** Embed-safe site chrome returned by the host after binding admission. */
export type VisitorSiteFacts = Readonly<{
  accent?: string;
  name: string;
  avatar: Avatar;
  origins: readonly string[];
}>;

/** An opened host door, disposed after the edge has returned a response. */
export type VisitorEdgeChannel = Readonly<{
  [Symbol.dispose]: () => void;
  readChannelSite: (
    input: Readonly<{ bindingId: string; siteKey: string }>,
  ) => Promise<VisitorSiteFacts | null>;
  mintChannelVisitor: (
    input: Readonly<{
      bindingId: string;
      siteKey: string;
      addressHash: string;
    }>,
  ) => Promise<VisitorGrant>;
  refreshChannelVisitor: (
    input: Readonly<{ bindingId: string; refreshSecret: string }>,
  ) => Promise<VisitorGrant>;
  rotateChannelVisitor: (
    input: Readonly<{
      bindingId: string;
      siteKey: string;
      accessToken: string;
      addressHash: string;
    }>,
  ) => Promise<VisitorGrant | Readonly<{ kind: "unauthorized" }>>;
  sendAsChannelVisitor: (
    input: Readonly<{
      bindingId: string;
      accessToken: string;
      requestId: string;
      text: string;
    }>,
  ) => Promise<IntakeResult | Readonly<{ kind: "unauthorized" }>>;
  withdrawAsChannelVisitor: (
    input: Readonly<{
      bindingId: string;
      accessToken: string;
      requestId: string;
    }>,
  ) => Promise<
    | ChannelWithdrawResult
    | Readonly<{ kind: "unauthorized" }>
    | Readonly<{
        kind: "denied";
        reason: "event_conflict" | "new_party_limit" | "banned";
      }>
  >;
  latestPendingAsChannelVisitor: (
    input: Readonly<{ bindingId: string; accessToken: string }>,
  ) => Promise<
    VisitorPendingPrompt | null | Readonly<{ kind: "unauthorized" }>
  >;
  watchAsChannelVisitor: (
    input: Readonly<{ bindingId: string; accessToken: string }>,
  ) => Promise<
    | Readonly<{ kind: "stream"; body: ReadableStream<Uint8Array> }>
    | Readonly<{ kind: "empty" }>
    | Readonly<{ kind: "unauthorized" }>
    | Readonly<{ kind: "denied"; reason: "suspended" | "stream_limit" }>
  >;
  openVisitorSession: (
    input: Readonly<{
      bindingId: string;
      accessToken: string;
      options: VisitorReadOptions;
    }>,
  ) => Promise<
    | Readonly<{ kind: "session"; snapshot: string }>
    | Readonly<{ kind: "unauthorized" }>
    | Readonly<{ kind: "denied"; reason: "new_party_limit" | "banned" }>
  >;
  readAsChannelVisitor: (
    input: Readonly<{ bindingId: string; accessToken: string }>,
  ) => Promise<
    | Readonly<{ kind: "view"; view: unknown }>
    | Readonly<{ kind: "unauthorized" }>
  >;
}>;

/**
 * Address lookup and mint/refresh use the site owner; conversation work must
 * receive a verified visitor first. A host may route different visitors to
 * different Agents without teaching the conversation core about its registry.
 */
export type VisitorEdgeHost<
  E extends HonoEnv,
  Site extends VisitorSiteAddress,
  Visitor extends object,
> = Readonly<{
  resolveSite: (context: Context<E>, siteKey: string) => Promise<Site | null>;
  openSite: (context: Context<E>, site: Site) => Promise<VisitorEdgeChannel>;
  authenticateVisitor: (
    context: Context<E>,
    site: Site,
    token: string,
  ) => Promise<Visitor | null>;
  openChannel: (
    context: Context<E>,
    site: Site,
    visitor: Visitor,
  ) => Promise<VisitorEdgeChannel>;
  addressHash: (context: Context<E>) => Promise<string>;
  assetPath: (kind: "widget" | "styles") => string;
  onError: (error: Error, context: Context<E>) => Response | Promise<Response>;
}>;

const DENIAL_STATUS = {
  unmapped: 404,
  suspended: 403,
  banned: 403,
  too_long: 413,
  party_daily_limit: 429,
  new_party_limit: 429,
  rate_limited: 429,
  address_limit: 429,
  stream_limit: 429,
  event_conflict: 409,
  refresh_invalid: 401,
  refresh_reused: 401,
} as const;

function denied(reason: keyof typeof DENIAL_STATUS): Response {
  return Response.json(
    { error: reason },
    { status: DENIAL_STATUS[reason], headers: { "cache-control": "no-store" } },
  );
}

/** Browsers always send Origin on POST; only the embed document may call. */
function sameOrigin<E extends HonoEnv>(context: Context<E>): boolean {
  return sameOriginRequest(context.req.raw);
}

function bearer<E extends HonoEnv>(context: Context<E>): string | null {
  const header = context.req.header("authorization") ?? "";
  const parsed = visitorBearerSchema.safeParse(
    header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "",
  );
  return parsed.success && parsed.data.startsWith("vt_") ? parsed.data : null;
}

function intakeResponse(result: IntakeResult): Response {
  return result.kind === "accepted" || result.kind === "held"
    ? Response.json(
        result.kind === "accepted"
          ? {
              status: "accepted",
              commandId: result.commandId,
              delivery: result.delivery,
            }
          : { status: "recorded", delivery: result.delivery },
        { status: 202, headers: { "cache-control": "no-store" } },
      )
    : denied(result.reason);
}

/** Only exact embed-safe origins reach the CSP header. */
function frameAncestors(origins: readonly string[]): string {
  return origins
    .filter((origin) => /^https?:\/\/(\*\.)?[a-z0-9.:[\]-]+$/u.test(origin))
    .join(" ");
}

/** Both values are already parsed: a site key and an optional `#rrggbb`. */
async function embedDocument(
  siteKey: string,
  facts: Readonly<{ accent?: string; name: string; avatar: Avatar }>,
  assets: (kind: "widget" | "styles") => string,
): Promise<string> {
  return (
    await html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="referrer" content="no-referrer" />
          <title>${facts.name}</title>
          <link rel="stylesheet" href="${assets("styles")}" />
        </head>
        <body class="caps-embed">
          <div
            id="fungi-embed"
            data-site="${siteKey}"
            data-accent="${facts.accent ?? ""}"
            data-name="${facts.name}"
            data-avatar="${JSON.stringify(facts.avatar)}"
          ></div>
          <script type="module" src="${assets("widget")}"></script>
        </body>
      </html>`
  ).toString();
}

export function createVisitorEdge<
  E extends HonoEnv,
  Site extends VisitorSiteAddress,
  Visitor extends object,
>(host: VisitorEdgeHost<E, Site, Visitor>): Hono<E> {
  async function route(context: Context<E>): Promise<Site | null> {
    const siteKey = siteKeySchema.safeParse(context.req.param("siteKey"));
    if (!siteKey.success) return null;
    return host.resolveSite(context, siteKey.data);
  }

  async function visitorChannel(
    context: Context<E>,
    site: Site,
    token: string,
  ): Promise<VisitorEdgeChannel | null> {
    const visitor = await host.authenticateVisitor(context, site, token);
    if (visitor === null) return null;
    return host.openChannel(context, site, visitor);
  }

  return new Hono<E>()
    .onError(host.onError)
    .get("/embed/v1/s/:siteKey", async (context) => {
      const site = await route(context);
      if (site === null) return context.text("Not found", 404);
      const siteKey = context.req.param("siteKey");
      using channels = await host.openSite(context, site);
      const facts = await channels.readChannelSite({
        bindingId: site.bindingId,
        siteKey,
      });
      if (facts === null) return context.text("Not found", 404);
      return new Response(await embedDocument(siteKey, facts, host.assetPath), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "font-src 'self'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "base-uri 'none'",
            "form-action 'none'",
            `frame-ancestors ${frameAncestors(facts.origins) || "'none'"}`,
          ].join("; "),
        },
      });
    })
    .get("/api/embed/v1/sites/:siteKey/theme", async (context) => {
      // Public chrome and an advisory address check. CSP still admits the frame.
      const headers = {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        vary: "Origin",
      };
      const site = await route(context);
      if (site === null)
        return context.json({ error: "unmapped" }, 404, headers);
      using channels = await host.openSite(context, site);
      const facts = await channels.readChannelSite({
        bindingId: site.bindingId,
        siteKey: context.req.param("siteKey"),
      });
      return facts === null
        ? context.json({ error: "unmapped" }, 404, headers)
        : context.json(
            {
              accent: facts.accent ?? null,
              originAllowed: originAllowed(
                facts.origins,
                context.req.header("origin") ?? new URL(context.req.url).origin,
              ),
            },
            200,
            headers,
          );
    })
    .post("/api/embed/v1/sites/:siteKey/visitors", async (context) => {
      if (!sameOrigin(context))
        return context.json({ error: "forbidden" }, 403);
      // Validate the host's address-key configuration before touching owners.
      const hash = await host.addressHash(context);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      using channels = await host.openSite(context, site);
      const grant = await channels.mintChannelVisitor({
        bindingId: site.bindingId,
        siteKey: context.req.param("siteKey"),
        addressHash: hash,
      });
      return grant.kind === "granted"
        ? Response.json(grant.credentials, {
            status: 201,
            headers: { "cache-control": "no-store" },
          })
        : denied(grant.reason);
    })
    .post("/api/embed/v1/sites/:siteKey/visitors/refresh", async (context) => {
      if (!sameOrigin(context))
        return context.json({ error: "forbidden" }, 403);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      const decoded = await context.req.json().then(
        (value) => ({
          kind: "decoded" as const,
          result: refreshSchema.safeParse(value),
        }),
        (cause: unknown) => ({ kind: "malformed" as const, cause }),
      );
      if (decoded.kind === "malformed" || !decoded.result.success)
        return context.json({ error: "invalid_input" }, 400);
      const body = decoded.result;
      using channels = await host.openSite(context, site);
      const grant = await channels.refreshChannelVisitor({
        bindingId: site.bindingId,
        refreshSecret: body.data.refreshSecret,
      });
      return grant.kind === "granted"
        ? Response.json(grant.credentials, {
            headers: { "cache-control": "no-store" },
          })
        : denied(grant.reason);
    })
    .post("/api/embed/v1/sites/:siteKey/visitors/rotate", async (context) => {
      if (!sameOrigin(context))
        return context.json({ error: "forbidden" }, 403);
      const token = bearer(context);
      if (token === null) return context.json({ error: "unauthorized" }, 401);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      using channels = await host.openSite(context, site);
      const grant = await channels.rotateChannelVisitor({
        bindingId: site.bindingId,
        siteKey: context.req.param("siteKey"),
        accessToken: token,
        addressHash: await host.addressHash(context),
      });
      if (grant.kind === "unauthorized")
        return context.json({ error: "unauthorized" }, 401);
      return grant.kind === "granted"
        ? Response.json(grant.credentials, {
            status: 201,
            headers: { "cache-control": "no-store" },
          })
        : denied(grant.reason);
    })
    .post("/api/embed/v1/sites/:siteKey/messages", async (context) => {
      if (!sameOrigin(context))
        return context.json({ error: "forbidden" }, 403);
      const token = bearer(context);
      if (token === null) return context.json({ error: "unauthorized" }, 401);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      const raw = await context.req.text();
      if (raw.length > 32_000) return denied("too_long");
      const json = decodeJson(raw);
      if (Option.isNone(json))
        return context.json({ error: "invalid_input" }, 400);
      const body = messageSchema.safeParse(json.value);
      if (!body.success) return context.json({ error: "invalid_input" }, 400);
      const opened = await visitorChannel(context, site, token);
      if (opened === null) return context.json({ error: "unauthorized" }, 401);
      using channels = opened;
      const result = await channels.sendAsChannelVisitor({
        bindingId: site.bindingId,
        accessToken: token,
        requestId: body.data.requestId,
        text: body.data.text,
      });
      return result.kind === "unauthorized"
        ? context.json({ error: "unauthorized" }, 401)
        : intakeResponse(result);
    })
    .post("/api/embed/v1/sites/:siteKey/requests/withdraw", async (context) => {
      if (!sameOrigin(context))
        return context.json({ error: "forbidden" }, 403);
      const token = bearer(context);
      if (token === null) return context.json({ error: "unauthorized" }, 401);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      const raw = await context.req.text();
      if (raw.length > 2_048) return denied("too_long");
      const json = decodeJson(raw);
      if (Option.isNone(json))
        return context.json({ error: "invalid_input" }, 400);
      const body = visitorRequestSchema.safeParse(json.value);
      if (!body.success) return context.json({ error: "invalid_input" }, 400);
      const opened = await visitorChannel(context, site, token);
      if (opened === null) return context.json({ error: "unauthorized" }, 401);
      using channels = opened;
      const result = await channels.withdrawAsChannelVisitor({
        bindingId: site.bindingId,
        accessToken: token,
        requestId: body.data.requestId,
      });
      if ("kind" in result)
        return result.kind === "unauthorized"
          ? context.json({ error: "unauthorized" }, 401)
          : denied(result.reason);
      return Response.json(result, {
        headers: { "cache-control": "no-store" },
      });
    })
    .get(
      "/api/embed/v1/sites/:siteKey/conversation/pending/latest",
      async (context) => {
        if (!sameOriginReadRequest(context.req.raw))
          return context.json({ error: "forbidden" }, 403);
        const token = bearer(context);
        if (token === null) return context.json({ error: "unauthorized" }, 401);
        const site = await route(context);
        if (site === null) return denied("unmapped");
        const opened = await visitorChannel(context, site, token);
        if (opened === null)
          return context.json({ error: "unauthorized" }, 401);
        using channels = opened;
        const result = await channels.latestPendingAsChannelVisitor({
          bindingId: site.bindingId,
          accessToken: token,
        });
        if (result !== null && "kind" in result)
          return context.json({ error: "unauthorized" }, 401);
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      },
    )
    .get(
      "/api/embed/v1/sites/:siteKey/conversation/events",
      async (context) => {
        if (!sameOriginReadRequest(context.req.raw))
          return context.json({ error: "forbidden" }, 403);
        const token = bearer(context);
        if (token === null) return context.json({ error: "unauthorized" }, 401);
        const site = await route(context);
        if (site === null) return denied("unmapped");
        const channel = await visitorChannel(context, site, token);
        if (channel === null)
          return context.json({ error: "unauthorized" }, 401);
        using channels = channel;
        const opened = await channels.watchAsChannelVisitor({
          bindingId: site.bindingId,
          accessToken: token,
        });
        if (opened.kind === "unauthorized")
          return context.json({ error: "unauthorized" }, 401);
        if (opened.kind === "denied") return denied(opened.reason);
        if (opened.kind === "empty") return context.body(null, 204);
        return new Response(opened.body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          },
        });
      },
    )
    .post("/api/embed/v1/sites/:siteKey/session", async (context) => {
      if (!sameOrigin(context))
        return context.json({ error: "forbidden" }, 403);
      const token = bearer(context);
      if (token === null) return context.json({ error: "unauthorized" }, 401);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      const raw = await context.req.text();
      if (raw.length > 4096)
        return context.json({ error: "invalid_input" }, 400);
      const json = decodeJson(raw);
      if (Option.isNone(json))
        return context.json({ error: "invalid_input" }, 400);
      const decoded = sessionReadSchema.safeParse(json.value);
      if (!decoded.success)
        return context.json({ error: "invalid_input" }, 400);
      const channel = await visitorChannel(context, site, token);
      if (channel === null) return context.json({ error: "unauthorized" }, 401);
      using channels = channel;
      const opened = await channels.openVisitorSession({
        bindingId: site.bindingId,
        accessToken: token,
        options: decoded.data,
      });
      if (opened.kind === "unauthorized")
        return context.json({ error: "unauthorized" }, 401);
      if (opened.kind === "denied") return denied(opened.reason);
      return new Response(opened.snapshot, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    })
    .get("/api/embed/v1/sites/:siteKey/conversation", async (context) => {
      const token = bearer(context);
      if (token === null) return context.json({ error: "unauthorized" }, 401);
      const site = await route(context);
      if (site === null) return denied("unmapped");
      // Retained legacy read: do not change its site-owner path in this slice.
      using channels = await host.openSite(context, site);
      const result = await channels.readAsChannelVisitor({
        bindingId: site.bindingId,
        accessToken: token,
      });
      return result.kind === "unauthorized"
        ? context.json({ error: "unauthorized" }, 401)
        : Response.json(result.view, {
            headers: { "cache-control": "no-store" },
          });
    });
}
