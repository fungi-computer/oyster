import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as z from "zod";

/** The parent accepts this constant only from its own iframe and serving origin. */
export const CLOSE_MESSAGE = "fungi-embed:close";

const embedThemeSchema = z.enum(["light", "dark", "auto"]).default("auto");

/** Decode the snippet's presentation choice; absent means the visitor's OS. */
export function parseEmbedTheme(value: string | undefined) {
  const parsed = embedThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json),
);
const siteThemeSchema = z.strictObject({
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/iu)
    .nullable(),
  originAllowed: z.boolean(),
});

/** Decode the bounded public accent, without taking host-page CSS or fonts. */
export function parseSiteTheme(
  body: string,
): z.infer<typeof siteThemeSchema> | null {
  if (body.length > 128) return null;
  const decoded = decodeJson(body);
  if (Option.isNone(decoded)) return null;
  const parsed = siteThemeSchema.safeParse(decoded.value);
  return parsed.success ? parsed.data : null;
}
