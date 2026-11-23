import { z } from "zod";
import { computerPortInputSchema } from "@fungi.computer/computer-contract";

// no-referrer turns a native form's Origin into null. Keep confirmation
// provenance; the issued-ticket redirect separately uses no-referrer.
export const portPreviewReferrerPolicy = "same-origin";

const issueRefusal = z.enum([
  "owner_required",
  "app_not_allowed",
  "preview_not_configured",
  "invalid_computer_address",
  "unexposed",
  "capacity",
]);
export type PortPreviewIssueRefusal = z.infer<typeof issueRefusal>;

/** The Computer preserves the reason for refusing issuance across RPC. */
export const portPreviewIssueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issued"), previewUrl: z.url() }),
  z.object({ kind: z.literal("refused"), reason: issueRefusal }),
]);
export type PortPreviewIssue = z.infer<typeof portPreviewIssueSchema>;

const portPreviewRefusalSchema = z.enum([
  ...issueRefusal.options,
  "confirmation_required",
  "same_origin_required",
  "computer_not_found",
  "invalid_port",
  "unavailable",
]);
export type PortPreviewRefusal = z.infer<typeof portPreviewRefusalSchema>;
const portPreviewRefusalResponseSchema = z.object({
  error: portPreviewRefusalSchema,
});

const messages = {
  owner_required: "Sign in as this Oyster's owner before opening the preview.",
  app_not_allowed:
    "This App is no longer allowed to open this Computer's preview.",
  preview_not_configured:
    "Private port previews aren't configured on this Oyster.",
  invalid_computer_address:
    "This Computer's address cannot be used for a private preview.",
  unexposed:
    "This port is no longer exposed. Expose it in Shed, then try again.",
  capacity:
    "Too many preview links are waiting to open. Wait a few minutes, then try again.",
  confirmation_required:
    "This request didn't include your confirmation. Choose Open preview in your Oyster.",
  same_origin_required:
    "This preview request came from another site. Open it from your Oyster.",
  computer_not_found: "That Computer doesn't belong to this Oyster.",
  invalid_port: "That preview link doesn't contain a valid port number.",
  unavailable: "The Computer couldn't create a preview right now. Try again.",
} satisfies Record<PortPreviewRefusal, string>;

export function portPreviewRefusalMessage(reason: PortPreviewRefusal): string {
  return messages[reason];
}

export const portPreviewRefusalStatus = {
  owner_required: 403,
  app_not_allowed: 403,
  preview_not_configured: 503,
  invalid_computer_address: 404,
  unexposed: 404,
  capacity: 429,
  confirmation_required: 403,
  same_origin_required: 403,
  computer_not_found: 404,
  invalid_port: 404,
  unavailable: 503,
} as const satisfies Record<PortPreviewRefusal, number>;

/** Only route text and a closed refusal enter the browser's confirmation. */
export const portPreviewEntrySchema = computerPortInputSchema.extend({
  action: z.string(),
  computerId: z.string(),
  computerName: z.string().optional(),
  refusal: portPreviewRefusalSchema.optional(),
});
export type PortPreviewEntry = z.infer<typeof portPreviewEntrySchema>;

/** Entry routes use the contract's bounds and one canonical decimal spelling. */
export function parsePortPreviewPort(text: string): number | undefined {
  const parsed = computerPortInputSchema.safeParse({ port: Number(text) });
  return parsed.success && String(parsed.data.port) === text
    ? parsed.data.port
    : undefined;
}

/** Decode the owned POST refusal into the next confirmation's presentation. */
export async function portPreviewRefusalEntry(
  response: Response,
  route: Readonly<{ action: string; computerId: string; port: string }>,
): Promise<PortPreviewEntry | undefined> {
  const port = parsePortPreviewPort(route.port);
  if (port === undefined) return undefined;
  let refusal: PortPreviewRefusal =
    response.status === 401 || response.status === 403
      ? "owner_required"
      : "unavailable";
  if (response.headers.get("Content-Type")?.startsWith("application/json")) {
    const parsed = portPreviewRefusalResponseSchema.safeParse(
      await response.clone().json(),
    );
    if (parsed.success) refusal = parsed.data.error;
  }
  return { action: route.action, computerId: route.computerId, port, refusal };
}
