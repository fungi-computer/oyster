import * as z from "zod/mini";

/** Why a sign-out-everywhere request was refused with 403, as the server names it. */
export const signOutRefusalSchema = z.object({
  error: z.enum(["origin_mismatch", "owner_removed"]),
});

/** The request did not come from the Oyster's own page. */
export const originMismatchRefusal = { error: "origin_mismatch" } as const;

/** The signed-in member is no longer this Oyster's owner. */
export const ownerRemovedRefusal = { error: "owner_removed" } as const;
