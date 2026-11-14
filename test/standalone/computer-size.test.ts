import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { describe, expect, it } from "vitest";
import { standaloneComputerSize } from "../../src/standalone/computer.js";

describe("a standalone Computer's size", () => {
  it("runs a Computer the fleet never created (the configured or build Computer) at the default size", () => {
    const database = new DatabaseSync(":memory:");
    try {
      expect(standaloneComputerSize(fromNodeSqlite(database).sql)).toBe(
        "default",
      );
    } finally {
      database.close();
    }
  });

  it("keeps the size the fleet fixed at creation", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const { sql } = fromNodeSqlite(database);
      standaloneComputerSize(sql);
      sql.exec(
        "INSERT INTO oyster_computer_size (singleton, size) VALUES (1, 'large')",
      );
      expect(standaloneComputerSize(sql)).toBe("large");
    } finally {
      database.close();
    }
  });
});
