import {
  computerGrantSchema,
  FleetGrantRefused,
  type ComputerGrant,
} from "@fungi.computer/computer/fleet";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentComputerConnection,
  AgentComputerSnapshot,
} from "../../src/agent-computer-source.js";
import { standaloneBrowserSave } from "../../src/standalone/agent-computers.js";

const attachment = {
  attachmentId: "attachment-one",
  computerId: "computer-one",
  version: 1,
  agentId: "agent-one",
  name: "Desk",
  admission: null,
} satisfies AgentComputerSnapshot["projection"]["attachments"][number];
const snapshot: AgentComputerSnapshot = {
  scopeId: "scope-one",
  agentId: "agent-one",
  projection: { revision: 1, attachments: [attachment] },
};
const bytes = new Uint8Array([1, 2, 3]);

function grant(actions: readonly string[], expiresAt = Date.now() + 60_000) {
  return computerGrantSchema.parse({
    computerId: "computer-one",
    actions: new Set(actions),
    expiresAt,
    provenance: { actor: "agent-one" },
  });
}

function access(
  admit: (connection: AgentComputerConnection) => Promise<ComputerGrant>,
) {
  const write = vi.fn(() => Promise.resolve());
  return { write, access: { admit, write } };
}

const request = {
  computerId: "computer-one",
  path: "/shots/page.png",
  bytes,
  contentType: "image/png",
};

describe("standalone browser save to a Computer", () => {
  it("writes the bytes to the named attached Computer and reports only the count", async () => {
    const { access: door, write } = access(() =>
      Promise.resolve(grant(["files.writeBytes"])),
    );
    const saved = await standaloneBrowserSave(door, () => snapshot)(request);
    expect(saved).toEqual({
      computerId: "computer-one",
      path: "/shots/page.png",
      bytes: 3,
    });
    expect(write).toHaveBeenCalledWith(
      "computer-one",
      expect.anything(),
      "/shots/page.png",
      bytes,
    );
  });

  it("refuses a Computer the Agent is not attached to before any admission", async () => {
    const admit = vi.fn(() => Promise.reject(new Error("must not admit")));
    const { access: door, write } = access(admit);
    await expect(
      standaloneBrowserSave(
        door,
        () => snapshot,
      )({
        ...request,
        computerId: "computer-other",
      }),
    ).rejects.toThrow("not a Computer this Agent is attached to");
    expect(admit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses when the Agent has no attachments at all", async () => {
    const { access: door, write } = access(() =>
      Promise.reject(new Error("must not admit")),
    );
    await expect(
      standaloneBrowserSave(door, () => null)(request),
    ).rejects.toThrow("not a Computer this Agent is attached to");
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a revoked attachment: the directory no longer admits it", async () => {
    const { access: door, write } = access(() =>
      Promise.reject(new FleetGrantRefused()),
    );
    await expect(
      standaloneBrowserSave(door, () => snapshot)(request),
    ).rejects.toBeInstanceOf(FleetGrantRefused);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a grant that lacks the write action", async () => {
    const { access: door, write } = access(() =>
      Promise.resolve(grant(["files.readBytes"])),
    );
    await expect(
      standaloneBrowserSave(door, () => snapshot)(request),
    ).rejects.toBeInstanceOf(FleetGrantRefused);
    expect(write).not.toHaveBeenCalled();
  });
});
