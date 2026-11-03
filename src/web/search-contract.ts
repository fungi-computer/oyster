import { z } from "zod";

export const webSearchInputSchema = z.strictObject({
  objective: z.string().trim().min(1).max(2_000),
  queries: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  maxResults: z.number().int().min(1).max(10).default(5),
});
export const webSearchOutputSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      url: z.string(),
      title: z.string().nullable(),
      publishDate: z.string().nullable(),
      excerpts: z.array(z.string()),
    }),
  ),
});
export type WebSearchInput = z.output<typeof webSearchInputSchema>;
export type WebSearchOutput = z.output<typeof webSearchOutputSchema>;
export type WebSearch = Readonly<{
  search: (
    input: WebSearchInput,
    signal: AbortSignal,
  ) => Promise<WebSearchOutput>;
}>;
