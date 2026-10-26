import { VeilError } from "@fungi.computer/veil";
import {
  createDnsOverHttpsResolver,
  resolvePublicAddresses,
  type HostResolver,
} from "@fungi.computer/veil/model-key-network";
import { CloudBrowserUrlDenied } from "./errors.js";

export type UrlCheckOptions = Readonly<{
  resolve?: HostResolver;
  signal: AbortSignal;
}>;

/**
 * The egress and URL policy every cloud-browser call checks before it reaches
 * Cloudflare Browser Run: http(s) only, no embedded credentials, and the
 * resolved name must be public unicast. This reuses the exact SSRF defence
 * Veil's public-fetch door and the Team's BYO model-key intake already use
 * (`@fungi.computer/veil/model-key-network`): a literal like `127.0.0.1` or
 * `169.254.169.254`, a private range like `10/8`, the box's own address, and
 * a rebinding hostname (one whose DNS answer is private) are all refused
 * here, before Cloudflare ever sees the URL. The name is resolved once; the
 * caller does not connect directly: Browser Run does in production, Chromium
 * does on staging. This check is not network confinement: a page can redirect,
 * load subresources or resolve the host differently after this check. Staging
 * must isolate Chromium's network egress before enabling Agent leases.
 */
export async function assertCloudBrowserUrlAllowed(
  raw: string,
  options: UrlCheckOptions,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudBrowserUrlDenied({
      reason: "invalid_url",
      message: `${raw} is not a URL`,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new CloudBrowserUrlDenied({
      reason: "unsupported_scheme",
      message: "only http(s) URLs are fetched",
    });
  if (url.username !== "" || url.password !== "")
    throw new CloudBrowserUrlDenied({
      reason: "credentials_in_url",
      message: "URLs with credentials are refused",
    });
  const resolve = options.resolve ?? createDnsOverHttpsResolver();
  try {
    await resolvePublicAddresses(url.hostname, resolve, options.signal);
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (error instanceof VeilError && error.code === "denied")
      throw new CloudBrowserUrlDenied({
        reason: "not_public",
        message: `${url.hostname} is not a public address`,
      });
    if (error instanceof VeilError)
      throw new CloudBrowserUrlDenied({
        reason: "dns_unavailable",
        message: `${url.hostname} did not resolve`,
      });
    throw error;
  }
  url.hash = "";
  return url;
}
