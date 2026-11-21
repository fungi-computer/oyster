import type { AppIdentity } from "@fungi.computer/agar";
import { renderPreviewChrome } from "./host-page-lazy.js";
import type { PreviewNotice } from "./host-page.js";
import { z } from "zod";
import type { BootUi } from "./boot-gate.js";
import { bootHostScript } from "#boot-host-script";

/** Resolve verified build paths with the browser's maintained URL semantics. */
export function bootAssetUrl(
  origin: string,
  base: string,
  path: string,
): string {
  const directory = new URL(origin);
  if (!directory.pathname.endsWith("/"))
    directory.pathname = `${directory.pathname}/`;
  const baseUrl = new URL(base, directory);
  return new URL(path.startsWith("/") ? path.slice(1) : path, baseUrl).href;
}

/** The trusted zero-grant parent and opaque candidate frame used by both hosts. */
export async function bootParentDocument(
  identity: AppIdentity,
  entry: string,
  options: Readonly<{
    bridge: string;
    sandbox: string;
    notice: PreviewNotice | null;
  }>,
): Promise<string> {
  const config = JSON.stringify({
    identity,
    entry,
    expiresAt: options.notice?.expiresAt,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App preview</title><body class="${options.notice === null ? "" : "preview-frame"}" style="margin:0;display:flex;flex-direction:column;height:100vh">
${options.notice === null ? "" : await renderPreviewChrome(options.notice)}
<iframe id="candidate" title="Candidate UI" sandbox="${options.sandbox}" style="width:100%;flex:1;min-height:0;border:0"></iframe>
<script id="boot-config" type="application/json">${config}</script>
<script type="module" src="${options.bridge}"></script></body></html>`;
}

/** CSP for the zero-grant candidate; all network-capable destinations remain denied. */
export function candidateSecurityHeaders(origin: string) {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline' " +
      origin +
      "; style-src 'unsafe-inline' " +
      origin +
      "; img-src data: blob: " +
      origin +
      "; font-src data: " +
      origin +
      "; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
  };
}

/** CSP for the trusted parent and its local bootstrap only. */
export function parentSecurityHeaders(candidatePrefix: string) {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src " +
      candidatePrefix +
      "; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
  };
}

/** Validate the shared mount paths before a host serves them. */
export function candidateAssetUrls(
  input: BootUi,
  origin: string,
): readonly string[] {
  const base = new URL(origin);
  const prefix = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  const entry = bootAssetUrl(origin, input.base, "/index.html");
  const assets = input.assets.map((asset) =>
    bootAssetUrl(origin, input.base, asset.path),
  );
  if (
    !assets.includes(entry) ||
    new Set(assets).size !== assets.length ||
    assets.some((asset) => {
      const parsed = new URL(asset);
      return (
        parsed.origin !== base.origin || !parsed.pathname.startsWith(prefix)
      );
    })
  )
    throw new Error("Candidate boot asset set is invalid");
  // Keep schema validation at the representation boundary; URLs above use the
  // browser platform parser, while this closed shape is Botanical's domain law.
  z.array(z.url()).parse(assets);
  return assets;
}

export { bootHostScript };
