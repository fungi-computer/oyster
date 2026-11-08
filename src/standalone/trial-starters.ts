import * as z from "zod";
import {
  installingAppSchema,
  type InstallingApp,
} from "@fungi.computer/nacre/workbench-directory";
import { owner, routes as routeTable, type Routes } from "../authorization.js";
import type { OysterEnv } from "../host.js";
import type { StandaloneRegistry } from "./registry.js";

/** What `oyster try` tells its Oyster about the starter Apps still being set up. */
export const trialStartersBodySchema = z.strictObject({
  installing: z.array(installingAppSchema).max(16),
});

/** One typed record the registry keeps durably. */
export type TrialPort<T> = Readonly<{
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
}>;

/** Where the trial's list and retry asks live. */
export type TrialStarterStorage = Readonly<{
  starters: TrialPort<readonly InstallingApp[]>;
  retries: TrialPort<readonly string[]>;
}>;

/**
 * The trial's starter-App state. `oyster try` replaces the list as each App
 * settles; the desktop asks for a retry of one App and `try` takes the asks.
 */
export function createTrialStarters(storage: TrialStarterStorage) {
  return {
    async list(): Promise<readonly InstallingApp[]> {
      return (await storage.starters.read()) ?? [];
    },
    async report(
      installing: readonly InstallingApp[],
    ): Promise<readonly InstallingApp[]> {
      const parsed = trialStartersBodySchema.parse({ installing }).installing;
      await storage.starters.write(parsed);
      return parsed;
    },
    /** Only a failed App can be retried; the ask is remembered until taken. */
    async requestRetry(installationId: string): Promise<boolean> {
      const current = await this.list();
      if (
        !current.some(
          (entry) =>
            entry.installationId === installationId && entry.state === "failed",
        )
      )
        return false;
      const asks = (await storage.retries.read()) ?? [];
      if (!asks.includes(installationId))
        await storage.retries.write([...asks, installationId]);
      return true;
    },
    async takeRetries(): Promise<readonly string[]> {
      const asks = (await storage.retries.read()) ?? [];
      if (asks.length > 0) await storage.retries.write([]);
      return asks;
    },
  };
}

/** Starters still listed once their App is installed no longer show as pending. */
export function pendingStarters(
  listed: readonly InstallingApp[],
  installedIds: readonly string[],
): readonly InstallingApp[] {
  return listed.filter((entry) => !installedIds.includes(entry.installationId));
}

export type RegistryBinding = () => Pick<
  StandaloneRegistry,
  | "reportTrialStarters"
  | "requestTrialRetry"
  | "takeTrialRetries"
  | "trialStartersList"
>;

/** Owner-key routes `oyster try` and the desktop use; the owner guard is declared per route. */
export function trialStarterRoutes(
  registry: RegistryBinding,
): Routes<OysterEnv> {
  const routes = routeTable<OysterEnv>();
  routes.put("/api/trial/starters", owner("direct"), async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ kind: "invalid" }, 400);
    }
    const parsed = trialStartersBodySchema.safeParse(body);
    if (!parsed.success) return context.json({ kind: "invalid" }, 400);
    await registry().reportTrialStarters(parsed.data.installing);
    return new Response(null, { status: 204 });
  });
  routes.get("/api/trial/starters", owner("direct"), async () =>
    Response.json(
      { installing: await registry().trialStartersList() },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
  routes.post(
    "/api/trial/starters/:installationId/retry",
    owner("direct"),
    async (context) =>
      (await registry().requestTrialRetry(context.req.param("installationId")))
        ? new Response(null, { status: 202 })
        : context.json({ kind: "not_retryable" }, 409),
  );
  routes.post("/api/trial/starters/retries", owner("direct"), async () =>
    Response.json(
      { retries: await registry().takeTrialRetries() },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
  return routes;
}
