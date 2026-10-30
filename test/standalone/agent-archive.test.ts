import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { agentArchive } from "../../src/standalone/agent-archive.js";

it("retains archive intent and tracks only archive-owned paused schedules", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const archive = agentArchive(owner.sql);
    expect(archive.read()).toEqual({
      archived: false,
      revision: 0,
      pending: false,
    });
    expect(() =>
      owner.transactionSync(() => {
        archive.transition(true);
        throw new Error("Busy refusal");
      }),
    ).toThrow("Busy refusal");
    expect(archive.read().archived).toBe(false);
    const changed = owner.transactionSync(() => archive.transition(true));
    expect(changed).toEqual({
      archived: true,
      revision: 1,
      pending: true,
    });
    archive.suspend("almanac", "schedule-a");
    archive.suspend("loop", "schedule-b");
    const reopened = agentArchive(owner.sql);
    reopened.ack(0);
    expect(reopened.read().pending).toBe(true);
    expect(reopened.suspended()).toEqual([
      { kind: "almanac", id: "schedule-a" },
      { kind: "loop", id: "schedule-b" },
    ]);
    reopened.ack(1);
    expect(reopened.read().pending).toBe(false);
    reopened.transition(false);
    reopened.resumed("loop", "schedule-b");
    expect(reopened.suspended()).toEqual([
      { kind: "almanac", id: "schedule-a" },
    ]);
  } finally {
    database.close();
  }
});
