/** Require the request's own Origin and refuse cross-site provenance. */
export function sameOriginRequest(request: Request): boolean {
  return request.headers.has("origin") && sameOriginReadRequest(request);
}

/** Channel reads allow absent Origin but never conflicting or cross-site provenance. */
export function sameOriginReadRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return (
    request.headers.get("sec-fetch-site") !== "cross-site" &&
    (origin === null || origin === new URL(request.url).origin)
  );
}
