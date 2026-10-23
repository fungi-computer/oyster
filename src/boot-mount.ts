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
export function bootParentDocument(
  identity: BootUi["identity"],
  entry: string,
  bridge = "./bridge.js",
): string {
  const config = JSON.stringify({ identity, entry }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><body>
<iframe id="candidate" sandbox="allow-scripts" style="width:100vw;height:100vh;border:0"></iframe>
<script id="boot-config" type="application/json">${config}</script>
<script type="module" src="${bridge}"></script></body></html>`;
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
