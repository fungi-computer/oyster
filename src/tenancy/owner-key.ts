import { ownerKeyAuth, ownerKeyCookieName } from "../auth.js";
import type { OwnerSessions } from "../owner-sessions.js";
import type { TenantId } from "../tenant.js";
import { Hono } from "hono";
import { parse } from "hono/utils/cookie";
import type {
  AuthAdapter,
  ReadonlyTenantRegistry,
  ReadonlyTenancy,
  Tenant,
} from "./contracts.js";

/** Stored owner verification material for one selected tenant. */
export type OwnerKeyRecord = Readonly<{
  /** The host-held owner secret, verified only by Oyster's auth helper. */
  key: string;
  /** Explicit canonical member identity stored by the host. */
  memberId: string;
}>;
/** Live owner authority and host-held verification material. */
export type OwnerKeyOptions = Readonly<{
  /** Current tenant owner authority, re-read after credential verification. */
  registry: Pick<ReadonlyTenantRegistry, "get">;
  /** Host-owned tenant key lookup; never Oyster's named Agent-key store. */
  keys: Readonly<{
    /** Current verification material, or null when no owner key is configured. */
    get(tenantId: TenantId): Promise<OwnerKeyRecord | null>;
  }>;
  /** Host-owned owner browser sessions for one tenant; the cookie names one of these. */
  sessions(tenantId: TenantId): OwnerSessions;
  /** Optional relative POST /login and POST /logout routes, explicitly mounted by the host. */
  login?: Readonly<{
    /** Resolve the tenant through the kit, not from form/body data. */
    resolveTenant: ReadonlyTenancy["resolve"];
  }>;
}>;

/** Reuse Oyster verification and admit only a current, explicitly stored owner. */
export function ownerKey(options: OwnerKeyOptions): AuthAdapter {
  const currentOwner = async (tenant: Tenant, memberId: string) => {
    const current = await options.registry.get(tenant.id);
    return (
      current !== null &&
      current.status === "active" &&
      current.owners.includes(memberId)
    );
  };
  const routes = new Hono();
  const login = options.login;
  if (login !== undefined)
    routes.post("/login", async (context) => {
      const tenant = await login.resolveTenant(context.req.raw);
      if (tenant === null) return context.json({ error: "not_found" }, 404);
      const record = await options.keys.get(tenant.id);
      if (record === null) return context.json({ error: "unauthorized" }, 401);
      // The session is stored only once the signed-in member is still the
      // tenant's owner, so a refused sign-in leaves no session behind.
      const sessions = options.sessions(tenant.id);
      const opened: Parameters<typeof sessions.open>[] = [];
      const helper = ownerKeyAuth(record.key, record.memberId, {
        ...sessions,
        open: (...session) => {
          opened.push(session);
          return Promise.resolve();
        },
      });
      if (helper.login === undefined)
        throw new Error("Oyster owner authentication has no login handler");
      const response = await helper.login(context.req.raw);
      if (response.status !== 303) return response;
      if (!(await currentOwner(tenant, record.memberId)))
        return context.json({ error: "forbidden" }, 403);
      for (const session of opened) await sessions.open(...session);
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
  if (login !== undefined)
    routes.post("/logout", async (context) => {
      const tenant = await login.resolveTenant(context.req.raw);
      if (tenant === null) return context.json({ error: "not_found" }, 404);
      const record = await options.keys.get(tenant.id);
      if (record === null) return context.json({ error: "unauthorized" }, 401);
      const helper = ownerKeyAuth(
        record.key,
        record.memberId,
        options.sessions(tenant.id),
      );
      if (helper.logout === undefined)
        throw new Error("Oyster owner authentication has no logout handler");
      return await helper.logout(context.req.raw);
    });
  const adapter: AuthAdapter = {
    id: "owner-key",
    async authenticate(request, tenant) {
      const cookies = parse(request.headers.get("Cookie") ?? "");
      const recognizedCookie = Object.hasOwn(cookies, ownerKeyCookieName);
      const authorization = request.headers.get("Authorization");
      const credential =
        authorization?.startsWith("Bearer ") === true ||
        authorization?.startsWith("Basic ") === true;
      if (!recognizedCookie && !credential) return { kind: "pass" };
      const record = await options.keys.get(tenant.id);
      if (record === null)
        return recognizedCookie
          ? { kind: "refused", status: 401 }
          : { kind: "pass" };
      const result = await ownerKeyAuth(
        record.key,
        record.memberId,
        options.sessions(tenant.id),
      ).authenticate(request);
      if (result.kind === "refused")
        return recognizedCookie
          ? { kind: "refused", status: 401 }
          : { kind: "pass" };
      if (!(await currentOwner(tenant, record.memberId)))
        return { kind: "refused", status: 403 };
      return {
        kind: "principal",
        principal: {
          actor: { kind: "member", memberId: record.memberId },
          role: "owner",
        },
      };
    },
  };
  return login === undefined ? adapter : { ...adapter, routes };
}
