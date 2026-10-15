/* global Response, URL, scheduler, fetch */
import { Notes } from "../examples/notes.js";

// One module-scope slot: the tenant-scope proof writes it from one Instance and
// reads it from another Instance of the same Release.
let moduleScopeValue = null;

// Native lifecycle fixture: keep a real request live until supervisor abort,
// and probe ambient egress, which the runtime denies (`globalOutbound: null`).
export class SlowNotes extends Notes {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/module-scope")) {
      if (request.method === "PUT") moduleScopeValue = await request.text();
      return Response.json({ moduleScopeValue });
    }
    if (path.endsWith("/wait")) {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS waiting(id INTEGER PRIMARY KEY)",
      );
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO waiting VALUES(1)");
      await scheduler.wait(60_000);
      return new Response("unexpected completion");
    }
    if (path.endsWith("/waiting")) {
      const exists =
        this.ctx.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='waiting'",
          )
          .toArray().length > 0;
      return Response.json({ waiting: exists });
    }
    if (path.endsWith("/egress")) {
      const target = request.headers.get("x-egress-target") ?? "";
      try {
        const response = await fetch(target);
        return Response.json({ egress: "allowed", status: response.status });
      } catch {
        return Response.json({ egress: "denied" });
      }
    }
    return super.fetch(request);
  }
}
