import { ownerKeyAuth } from "../auth.js";
import { OysterArchivingError } from "./old-worker-readonly.js";

const path = "/__upgrade/registry-sql";
const noStore = { "Cache-Control": "no-store" };

function archivingResponse(): Response {
  const refusal = new OysterArchivingError();
  return Response.json(
    { error: refusal.code, message: refusal.message },
    { status: 503, headers: noStore },
  );
}

/** Export-only ingress: every request except owner GET is refused here. */
export async function oldRegistrySqlRequest(
  request: Request,
  ownerKey: string,
  exportRegistry: () => Promise<Response>,
): Promise<Response> {
  if (new URL(request.url).pathname !== path || request.method !== "GET")
    return archivingResponse();
  if (request.headers.get("Authorization")?.startsWith("Bearer ") !== true)
    return new Response(null, { status: 401, headers: noStore });
  const result = await ownerKeyAuth(ownerKey).authenticate(request);
  if (
    result.kind !== "admitted" ||
    result.principal.actor.kind !== "member" ||
    !("role" in result.principal) ||
    result.principal.role !== "owner"
  )
    return new Response(null, { status: 401, headers: noStore });
  return exportRegistry();
}
