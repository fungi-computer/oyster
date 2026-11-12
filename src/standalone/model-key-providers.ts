import {
  catalogModelKeyProviders,
  isCatalogModelKeyProvider,
  type CatalogModelKeyProvider,
} from "@fungi.computer/veil/model-keys";

/**
 * Standalone custody takes every catalog provider's API key, plus an owner's
 * Cloudflare account and token.
 */
export type StandaloneModelKeyProvider =
  CatalogModelKeyProvider | "cloudflare-workers-ai";
export const isStandaloneModelKeyProvider = (
  value: string,
): value is StandaloneModelKeyProvider =>
  value === "cloudflare-workers-ai" || isCatalogModelKeyProvider(value);

/** What the owner may connect, in display order; the Settings form is built from it. */
export const modelKeyProviderChoices: readonly Readonly<{
  id: StandaloneModelKeyProvider;
  label: string;
  accountId: boolean;
}>[] = [
  {
    id: "cloudflare-workers-ai",
    label: "Cloudflare Workers AI",
    accountId: true,
  },
  ...Object.entries(catalogModelKeyProviders).flatMap(([id, { label }]) =>
    isCatalogModelKeyProvider(id) ? [{ id, label, accountId: false }] : [],
  ),
];
