import { SignJWT, errors, jwtVerify, type JWTVerifyResult } from "jose";
import { z } from "zod";
import {
  door,
  owner,
  publicRoute,
  routes,
  type OwnerPrincipal,
} from "../authorization.js";
import type { OysterEnv } from "../host.js";
import type { OysterBuildView } from "../app-builds.js";
import { readPreviewUi } from "../boot-gate.js";
import {
  bootAssetUrl,
  bootHostScript,
  bootParentDocument,
  candidateAssetUrls,
  parentSecurityHeaders,
} from "../boot-mount.js";
import {
  readCachedVerified,
  ReleaseError,
  type ArtifactStore,
} from "../release.js";
import { renderHostPage, renderPreviewStyles } from "../host-page-lazy.js";
import type { TenantScope } from "../tenant.js";

/** S7 supplies the live refs and the base captured for this build; Oyster owns no proposal ledger. */
export type CandidatePreviewProposal = Readonly<{
  headRevision: string;
  baseRevision: string;
  buildBaseRevision: string;
}>;

/** Read-only candidate custody; no Instance, selection, storage or build-start port. */
export type CandidatePreviewOptions = Readonly<{
  scope: Pick<TenantScope, "tenantId" | "origin">;
  secret: string;
  owner(): Promise<OwnerPrincipal | null>;
  readBuild(jobId: string): Promise<OysterBuildView | null>;
  artifacts: ArtifactStore;
  /** Absent/null for manual builds. S7 can join proposal refs without changing readBuild. */
  readProposal?(
    build: OysterBuildView,
  ): Promise<CandidatePreviewProposal | null>;
}>;

// Human candidates must never inherit installed Apps' escaping popups or forms.
const candidateSandbox = "allow-scripts";
const issuer = "oyster.candidate-preview";
const purpose = "oyster/candidate-preview/v1";
const lifetimeSeconds = 5 * 60;
const claimsSchema = z.object({
  tenantId: z.string().min(1).max(40),
  ownerId: z.string().min(1).max(256),
  origin: z.url(),
  jobId: z.string().min(1).max(256),
  appId: z.string().min(1).max(256),
  releaseId: z.string().min(1).max(256),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sourceRevision: z.string().regex(/^git:[a-f0-9]{40}$/u),
});
const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};
const unavailable = (
  status: 403 | 404 = 404,
  message = "Candidate preview unavailable",
) => new Response(message, { status, headers: privateHeaders });

function candidateHeaders(prefix: string) {
  return {
    ...privateHeaders,
    "content-security-policy": `default-src 'none'; sandbox ${candidateSandbox}; script-src 'unsafe-inline' ${prefix}; style-src 'unsafe-inline' ${prefix}; img-src data: blob: ${prefix}; font-src data: ${prefix}; connect-src ${prefix}; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`,
  };
}

/** Owner arrival and the private, zero-grant UI of an unselected build. */
export function standaloneCandidatePreview(options: CandidatePreviewOptions) {
  const table = routes<OysterEnv>();
  const path = "/builds/:jobId/preview";
  const signingKey = () =>
    crypto.subtle
      .importKey(
        "raw",
        new TextEncoder().encode(options.secret),
        "HKDF",
        false,
        ["deriveKey"],
      )
      .then((key) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(),
            info: new TextEncoder().encode(purpose),
          },
          key,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign", "verify"],
        ),
      );
  const audience = `${purpose}:${options.scope.origin}`;
  const readCustody = async (jobId: string, ownerId: string) => {
    if ((await options.owner())?.actor.memberId !== ownerId) return null;
    const build = await options.readBuild(jobId);
    if (
      build?.status !== "succeeded" ||
      build.appId !== build.release?.appId ||
      build.releaseId !== build.release.releaseId ||
      build.sourceRevision !== build.release.artifact.provenance.sourceRevision
    )
      return null;
    return { build, release: build.release };
  };
  const candidate = async (jobId: string, ownerId: string) => {
    const custody = await readCustody(jobId, ownerId);
    if (custody === null) return null;
    const preview = await readPreviewUi(options.artifacts, custody.release);
    return preview.ui === null
      ? null
      : { ...custody, ui: preview.ui, appName: preview.appName };
  };
  const stillCurrent = async (claims: z.output<typeof claimsSchema>) => {
    const current = await readCustody(claims.jobId, claims.ownerId);
    return (
      current !== null &&
      current.build.appId === claims.appId &&
      current.build.releaseId === claims.releaseId &&
      current.release.artifact.artifactDigest === claims.digest &&
      current.build.sourceRevision === claims.sourceRevision
    );
  };
  const landing = async (action: string, appName?: string) => {
    const response = await renderHostPage({
      state: "preview",
      preview: { action, appName, preparing: appName === undefined },
      inlineStyles: await renderPreviewStyles(),
    });
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(privateHeaders))
      headers.set(name, value);
    headers.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  };
  table.get(
    path,
    publicRoute("styled arrival without candidate metadata"),
    (context) => landing(context.req.path),
  );
  table.post(path, owner("direct"), async (context, { principal }) => {
    const requestOrigin = context.req.header("Origin");
    if (
      new URL(context.req.url).origin !== options.scope.origin ||
      (context.req.header("Sec-Fetch-Site") !== "same-origin" &&
        requestOrigin !== options.scope.origin)
    )
      return unavailable(403, "Same-origin owner request required");
    try {
      let preparing = false;
      if (context.req.raw.body !== null) {
        const fields = await context.req.raw
          .formData()
          .catch((cause: unknown) => {
            if (cause instanceof TypeError) return null;
            throw cause;
          });
        if (fields === null)
          return unavailable(
            403,
            "Could not open this preview. Reload to try again.",
          );
        preparing = fields.get("intent") === "prepare";
      }
      const current = await candidate(
        context.req.param("jobId"),
        principal.actor.memberId,
      );
      if (current === null) return unavailable();
      const { build, release, ui, appName } = current;
      const claims = claimsSchema.parse({
        tenantId: options.scope.tenantId,
        ownerId: principal.actor.memberId,
        origin: options.scope.origin,
        jobId: build.jobId,
        appId: build.appId,
        releaseId: build.releaseId,
        digest: release.artifact.artifactDigest,
        sourceRevision: build.sourceRevision,
      });
      if (preparing) {
        if (!(await stillCurrent(claims))) return unavailable();
        return await landing(context.req.path, appName);
      }
      const proposal = await options.readProposal?.(build);
      if (!(await stillCurrent(claims))) return unavailable();
      const now = Math.floor(Date.now() / 1000);
      const grant = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(claims.ownerId)
        .setIssuedAt(now)
        .setExpirationTime(now + lifetimeSeconds)
        .sign(await signingKey());
      const root = new URL(
        `/private-builds/${encodeURIComponent(grant)}/`,
        options.scope.origin,
      );
      const prefix = new URL("candidate/", root).href;
      candidateAssetUrls(ui, prefix);
      const identity = {
        ...ui.identity,
        surfaceId: `preview:${build.releaseId}`,
      };
      const freshness =
        proposal === undefined || proposal === null
          ? "This build was not checked against the latest proposal."
          : proposal.headRevision !== build.sourceRevision ||
              proposal.baseRevision !== proposal.buildBaseRevision
            ? "The proposal changed after this build. Open a new preview before merging."
            : "The proposal matched when this preview opened. Check it again in Bonsai before merging.";
      const notice = {
        appName,
        revision: build.sourceRevision.slice(4, 11),
        status:
          proposal === undefined || proposal === null
            ? "not checked"
            : proposal.headRevision !== build.sourceRevision ||
                proposal.baseRevision !== proposal.buildBaseRevision
              ? "changed"
              : "checked",
        explanation: freshness,
        expiresAt: (now + lifetimeSeconds) * 1000,
        entry: context.req.path,
      };
      return new Response(
        await bootParentDocument(
          identity,
          bootAssetUrl(prefix, ui.base, "/index.html"),
          {
            bridge: new URL("bridge.js", root).href,
            sandbox: candidateSandbox,
            notice,
          },
        ),
        {
          headers: {
            ...parentSecurityHeaders(prefix),
            ...privateHeaders,
            "content-security-policy": `${parentSecurityHeaders(prefix)["content-security-policy"]}; font-src data:; frame-ancestors 'none'`,
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    } catch (cause) {
      if (cause instanceof ReleaseError) return unavailable();
      throw cause;
    }
  });
  table.get(
    "/private-builds/:grant/*",
    door(
      "purpose-bound candidate grant, current owner and immutable build custody",
    ),
    async (context) => {
      const url = new URL(context.req.url);
      if (url.origin !== options.scope.origin || url.search !== "")
        return unavailable();
      const grant = context.req.param("grant");
      if (grant.length > 4096) return unavailable();
      let verified: JWTVerifyResult;
      try {
        verified = await jwtVerify(grant, await signingKey(), {
          issuer,
          audience,
          algorithms: ["HS256"],
          typ: "JWT",
          maxTokenAge: lifetimeSeconds,
          requiredClaims: ["exp", "iat", "sub"],
        });
      } catch (cause) {
        if (cause instanceof errors.JWTExpired)
          return unavailable(
            404,
            "This preview expired. Reload to open it again.",
          );
        if (cause instanceof errors.JOSEError) return unavailable();
        throw cause;
      }
      const parsed = claimsSchema.safeParse(verified.payload);
      if (!parsed.success || verified.payload.exp === undefined)
        return unavailable();
      const expiresAt = verified.payload.exp * 1000;
      const claims = parsed.data;
      if (
        claims.origin !== options.scope.origin ||
        claims.tenantId !== options.scope.tenantId ||
        verified.payload.sub !== claims.ownerId
      )
        return unavailable();
      try {
        const current = await candidate(claims.jobId, claims.ownerId);
        if (
          current?.build.appId !== claims.appId ||
          current.build.releaseId !== claims.releaseId ||
          current.release.artifact.artifactDigest !== claims.digest ||
          current.build.sourceRevision !== claims.sourceRevision
        )
          return unavailable();
        const root = new URL(
          `/private-builds/${encodeURIComponent(grant)}/`,
          options.scope.origin,
        );
        const prefix = new URL("candidate/", root).href;
        if (!(await stillCurrent(claims)) || Date.now() >= expiresAt)
          return unavailable();
        if (url.pathname === new URL("bridge.js", root).pathname)
          return new Response(bootHostScript, {
            headers: {
              ...privateHeaders,
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        const urls = candidateAssetUrls(current.ui, prefix);
        const index = urls.findIndex(
          (asset) => new URL(asset).pathname === url.pathname,
        );
        const asset = current.ui.assets[index];
        if (asset === undefined) return unavailable();
        const bytes = await readCachedVerified(
          options.artifacts,
          undefined,
          asset.artifactRef,
          asset.digest,
        );
        // Storage I/O must not let an expired grant deliver another response.
        if (!(await stillCurrent(claims)) || Date.now() >= expiresAt)
          return unavailable();
        const headers = new Headers({
          ...candidateHeaders(prefix),
          "content-type": asset.contentType,
        });
        if (context.req.header("Origin") === "null") {
          headers.set("access-control-allow-origin", "null");
          headers.set("vary", "Origin");
        }
        return new Response(bytes, { headers });
      } catch (cause) {
        if (cause instanceof ReleaseError) return unavailable();
        throw cause;
      }
    },
  );
  table.all(
    "/private-builds/*",
    door("refuse unsupported private candidate requests"),
    () => unavailable(),
  );
  return { routes: table };
}
