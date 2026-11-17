import { DurableObject } from "cloudflare:workers";
import { appBackend, type NotesContext } from "./methods.js";

class NotesFacet extends DurableObject implements NotesContext {
  declare public ctx: DurableObjectState<Record<never, never>>;
}

export const Notes = appBackend.implement(NotesFacet);
