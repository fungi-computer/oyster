import { ownerKeyCredential } from "../auth.js";
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
  if ((await ownerKeyCredential(ownerKey, request)) !== "owner")
    return new Response(null, { status: 401, headers: noStore });
  return exportRegistry();
}
