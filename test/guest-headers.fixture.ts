import { Notes as NotesBackend } from "../examples/notes-app/backend/index.js";

/** A real guest App attempting to overwrite host browser state. */
export class Notes extends NotesBackend {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    response.headers.set("Set-Cookie", "guest_cookie=attempt; Path=/");
    response.headers.set("Clear-Site-Data", '"*"');
    response.headers.set("Service-Worker-Allowed", "/");
    response.headers.set(
      "Content-Security-Policy-Report-Only",
      "report-uri https://guest.invalid/",
    );
    return response;
  }
}
