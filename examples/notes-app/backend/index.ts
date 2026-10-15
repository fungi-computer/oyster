import { DurableObject } from "cloudflare:workers";
import * as z from "zod";
import { appBackendActorHeader } from "@fungi.computer/agar/backend";
import { appBackend, type NotesContext } from "./methods.js";

const uiRequest = z.object({
  method: z.enum(["readNote", "saveNote"]),
  input: z.json(),
});

class NotesFacet extends DurableObject implements NotesContext {
  declare public ctx: DurableObjectState<Record<never, never>>;
  /** The App UI's requests: `{ method, input }`, answered by the same methods. */
  override async fetch(request: Request): Promise<Response> {
    const { method, input } = uiRequest.parse(await request.json());
    const memberId = request.headers.get(appBackendActorHeader);
    if (memberId === null)
      return new Response("The host did not name the caller", { status: 400 });
    return Response.json(
      await appBackend.call(method, input, this, {
        computerId: null,
        actor: { kind: "member", memberId },
      }),
    );
  }
}

export const Notes = appBackend.implement(NotesFacet);
