import { describe, expect, it } from "vitest";
import { standaloneHomeInstructionsFile } from "../../src/standalone/computer.js";

type Computer = Parameters<typeof standaloneHomeInstructionsFile>[0];

/** A Computer holding one file, answering as the native owner does. */
function computer(initial: string | null) {
  let stored = initial;
  const grants: string[] = [];
  const native: Computer = {
    fileRead: (authority) => {
      grants.push(authority.provenance.actor);
      return Promise.resolve(
        stored === null ? null : new TextEncoder().encode(stored),
      );
    },
    fileReplace: (authority, path, expected, content) => {
      grants.push(authority.provenance.actor);
      expect(path).toBe("/AGENTS.md");
      if (stored !== expected)
        return Promise.resolve({ kind: "conflict" as const });
      stored = content;
      return Promise.resolve({
        kind: "replaced" as const,
        path,
        bytes: content.length,
      });
    },
  };
  return { native, grants, stored: () => stored };
}

describe("an owner's AGENTS.md on a standalone Computer", () => {
  it("reads absence as null and text as it is stored, under the owner's grant", async () => {
    const empty = computer(null);
    const file = standaloneHomeInstructionsFile(
      empty.native,
      "workspace",
      "owner-actor",
    );
    expect(await file.read()).toBeNull();
    const present = computer("﻿Be brief.\r\n");
    expect(
      await standaloneHomeInstructionsFile(
        present.native,
        "workspace",
        "owner-actor",
      ).read(),
    ).toBe("﻿Be brief.\r\n");
    expect(present.grants).toEqual(["owner-actor"]);
  });

  it("creates once, replaces from what was read, and reports a changed file", async () => {
    const held = computer(null);
    const file = standaloneHomeInstructionsFile(held.native, "w", "owner");
    expect(await file.replace(null, "First.")).toMatchObject({
      kind: "replaced",
    });
    expect(await file.replace(null, "Again.")).toEqual({ kind: "conflict" });
    expect(await file.replace("First.", "Second.")).toMatchObject({
      kind: "replaced",
    });
    expect(await file.replace("First.", "Third.")).toEqual({
      kind: "conflict",
    });
    expect(held.stored()).toBe("Second.");
  });
});
