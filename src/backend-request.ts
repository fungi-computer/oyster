/** Second boundary before an admitted request enters customer backend code.
 * Hub normally builds this shape itself; callers of the App runtime must not
 * be able to pass their own headers through the facet.
 */
import {
  appBackendActorHeader,
  appBackendComputerHeader,
} from "@fungi.computer/agar/backend";

export function appFacetRequest(request: Request): Request {
  const headers = new Headers();
  for (const name of [
    "Content-Type",
    appBackendActorHeader,
    appBackendComputerHeader,
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  };
  if (request.body !== null) init.duplex = "half";
  return new Request(request.url, init);
}

/** Only content metadata crosses back from a guest; origin policy is host-owned. */
export function appFacetResponse(response: Response): Response {
  const headers = new Headers();
  for (const name of [
    "Content-Type",
    "Content-Language",
    "Content-Encoding",
    "Content-Length",
    "Content-Disposition",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
