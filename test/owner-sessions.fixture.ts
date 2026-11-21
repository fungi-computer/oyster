import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { ownerSessionStore } from "../src/owner-sessions.js";

/** Real owner sessions over an in-memory SQLite database. */
export function memoryOwnerSessions() {
  return ownerSessionStore(fromNodeSqlite(new DatabaseSync(":memory:")).sql);
}
