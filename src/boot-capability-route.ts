import { createHash } from "node:crypto";
import { parseReleaseId } from "@fungi.computer/puffball";
import { z } from "zod";
import {
  BOOT_CAPABILITY_HEADER,
  type BootCapabilityAsset,
  type BootCapabilityStore,
} from "./boot-capability.js";
import { type BootUi } from "./boot-gate.js";
import { defaultAssetPolicy } from "./release.js";
import {
  bootAssetUrl,
  bootHostScript,
  bootParentDocument,
  candidateAssetUrls,
  candidateSecurityHeaders,
  parentSecurityHeaders,
} from "./boot-mount.js";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const candidatePreflightPathSchema = z
  .tuple([
    z.literal("_boot"),
    z.string(),
    z.literal("candidate"),
    z.string().min(1),
  ])
  .rest(z.string().min(1));
const capabilityPreflightSchema = z.object({
  method: z.literal("OPTIONS"),
  search: z.literal(""),
  origin: z.literal("null"),
  requestedMethod: z.literal("GET"),
  requestedHeaders: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.literal(BOOT_CAPABILITY_HEADER)),
  path: candidatePreflightPathSchema,
});

/** The artifact bucket read the route needs; an R2 bucket is one. */
export type BootAssetBucket = Readonly<{
  get(key: string): Promise<Readonly<{
    size: number;
    body: ReadableStream<Uint8Array>;
  }> | null>;
}>;

export type BootCapabilityRouteOptions = Readonly<{
  configuredOrigin: string;
  bucket: BootAssetBucket;
  capabilities: BootCapabilityStore;
}>;

/** Worker-only HTTPS endpoint for a single digest-authorized boot lease. */
export async function serveBootCapability(
  request: Request,
  options: BootCapabilityRouteOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_boot/")) return null;
  const configured = new URL(options.configuredOrigin);
  // The same origins checkBootPage opens: https, or http on loopback only.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    configured.hostname,
  );
  if (
    (configured.protocol !== "https:" &&
      !(configured.protocol === "http:" && loopback)) ||
    configured.pathname !== "/" ||
    configured.search !== "" ||
    configured.hash !== "" ||
    configured.username !== "" ||
    configured.password !== "" ||
    url.origin !== configured.origin
  )
    return refusal(404);

  const segments = url.pathname.split("/");
  if (isCapabilityPreflight(request, url, segments))
    return capabilityPreflight();
  const token = tokenSchema.safeParse(
    request.headers.get(BOOT_CAPABILITY_HEADER),
  );
  if (
    request.method !== "GET" ||
    url.search !== "" ||
    segments[2] === "" ||
    !token.success ||
    segments.length < 4 ||
    segments[0] !== "" ||
    segments[1] !== "_boot"
  )
    return refusal(404);

  const tokenDigest = createHash("sha256")
    .update(token.data, "utf8")
    .digest("hex");
  const lease = await options.capabilities.resolve(tokenDigest, Date.now());
  if (lease === null) return refusal(404);
  // The capability store returns a lease already decoded at its persistence boundary.
  const checkedLease = lease;
  if (checkedLease.identity.releaseId !== segments[2]) return refusal(404);
  const assets = checkedLease.assets.map(bootUiAsset);
  const ui: BootUi = {
    identity: checkedLease.identity,
    base: checkedLease.base,
    assets,
  };
  const root = new URL(
    `/_boot/${checkedLease.identity.releaseId}/`,
    configured.origin,
  );
  const candidateBase = new URL("candidate/", root);
  const urls = candidateAssetUrls(ui, candidateBase.href);
  const entry = bootAssetUrl(
    candidateBase.href,
    checkedLease.base,
    "/index.html",
  );
  if (Date.now() >= checkedLease.expiresAt) return refusal(404);

  const parentPath = `${root.pathname}index.html`;
  const bridgePath = `${root.pathname}bridge.js`;
  if (url.pathname === parentPath) {
    return new Response(bootParentDocument(checkedLease.identity, entry), {
      status: 200,
      headers: {
        ...parentSecurityHeaders(candidateBase.href),
        "content-type": "text/html; charset=utf-8",
      },
    });
  }
  if (url.pathname === bridgePath) {
    return new Response(bootHostScript, {
      status: 200,
      headers: {
        ...parentSecurityHeaders(candidateBase.href),
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }

  const assetIndex = urls.findIndex((assetUrl) => {
    const asset = new URL(assetUrl);
    return asset.origin === url.origin && asset.pathname === url.pathname;
  });
  const asset = checkedLease.assets[assetIndex];
  if (asset === undefined) return refusal(404);
  if (Date.now() >= checkedLease.expiresAt) return refusal(404);
  const object = await options.bucket.get(asset.artifactRef);
  if (object?.size !== asset.byteLength) return refusal(404);
  const headers = new Headers({
    ...candidateSecurityHeaders(candidateBase.href),
    "content-type": asset.contentType,
    "x-content-type-options": "nosniff",
  });
  if (request.headers.get("origin") === "null") {
    headers.set("access-control-allow-origin", "null");
    headers.set("vary", "Origin");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  const verified = object.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (Date.now() >= checkedLease.expiresAt) {
          controller.error(new Error("Boot asset lease expired"));
          return;
        }
        byteLength += chunk.byteLength;
        if (byteLength > defaultAssetPolicy.maxObjectBytes) {
          controller.error(new Error("Boot asset exceeds its size limit"));
          return;
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (
          byteLength !== asset.byteLength ||
          `sha256:${hash.digest("hex")}` !== asset.digest
        )
          controller.error(new Error("Boot asset verification failed"));
      },
    }),
  );
  return new Response(verified, { status: 200, headers });
}

function isCapabilityPreflight(
  request: Request,
  url: URL,
  segments: readonly string[],
): boolean {
  const preflight = capabilityPreflightSchema.safeParse({
    method: request.method,
    search: url.search,
    origin: request.headers.get("origin"),
    requestedMethod: request.headers.get("access-control-request-method"),
    requestedHeaders: request.headers.get("access-control-request-headers"),
    path: segments.slice(1),
  });
  if (!preflight.success) return false;
  try {
    parseReleaseId(preflight.data.path[1]);
    return true;
  } catch {
    return false;
  }
}

function capabilityPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "null",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": BOOT_CAPABILITY_HEADER,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      "x-content-type-options": "nosniff",
    },
  });
}

function bootUiAsset(asset: BootCapabilityAsset): BootUi["assets"][number] {
  return {
    path: asset.path,
    contentType: asset.contentType,
    artifactRef: asset.artifactRef,
    digest: asset.digest,
  };
}

function refusal(status: 404): Response {
  return new Response("Boot resource unavailable", {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
