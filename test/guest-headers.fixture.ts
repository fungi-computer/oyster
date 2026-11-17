import { Notes as NotesBackend } from "../examples/notes-app/backend/index.js";

/** A real guest App attempting to overwrite host browser state. */
export class Notes extends NotesBackend {
  fetch(): Promise<Response> {
    const response = Response.json({ probe: "guest headers" });
    response.headers.set("Set-Cookie", "guest_cookie=attempt; Path=/");
    response.headers.set("Clear-Site-Data", '"*"');
    response.headers.set("Service-Worker-Allowed", "/");
    response.headers.set(
      "Content-Security-Policy-Report-Only",
      "report-uri https://guest.invalid/",
    );
    return Promise.resolve(response);
  }
}
