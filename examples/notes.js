/* global Response */
import { DurableObject } from "cloudflare:workers";

// An ordinary backend: only its own SQLite, no platform namespace or credentials.
export class Notes extends DurableObject {
  async fetch(request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY CHECK(id=1), text TEXT NOT NULL)",
    );
    if (request.method === "PUT") {
      const text = await request.text();
      this.ctx.storage.sql.exec(
        "INSERT INTO notes VALUES(1,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text",
        text,
      );
    }
    const row = this.ctx.storage.sql
      .exec("SELECT text FROM notes WHERE id=1")
      .toArray()[0];
    return Response.json({ text: row?.text ?? null, release: "v1" });
  }
}
