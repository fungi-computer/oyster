import { describe, expect, it } from "vitest";
import { channelIds } from "../../src/channels/ids.js";
import {
  visitorMessageId,
  visitorRequestSchema,
} from "../../src/channels/visitor-request.js";
import { createVisitorStreamSlots } from "../../src/channels/visitor-stream-slots.js";

describe("visitor request identity", () => {
  it("maps the original caller request to one valid, deterministic channel message id", async () => {
    const requestId = "same browser composer request";
    expect(visitorRequestSchema.parse({ requestId })).toEqual({ requestId });
    const first = await visitorMessageId(requestId);
    expect(first).toBe(await visitorMessageId(requestId));
    expect(first).not.toBe(await visitorMessageId("another browser request"));
    expect(channelIds.message.is(first)).toBe(true);
    expect(first.startsWith("msg_")).toBe(true);
  });

  it("rejects missing and oversized original request identities", async () => {
    expect(visitorRequestSchema.safeParse({ requestId: "" }).success).toBe(
      false,
    );
    expect(
      visitorRequestSchema.safeParse({ requestId: "x".repeat(257) }).success,
    ).toBe(false);
    await expect(visitorMessageId("")).rejects.toThrow();
  });
});

describe("visitor stream slots", () => {
  it("permits two watches per visitor, and releases a slot only once", () => {
    const acquire = createVisitorStreamSlots();
    const first = acquire("binding", "visitor", "address");
    const second = acquire("binding", "visitor", "address");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(acquire("binding", "visitor", "address")).toBeNull();
    first?.();
    first?.();
    const replacement = acquire("binding", "visitor", "address");
    expect(replacement).not.toBeNull();
    expect(acquire("binding", "visitor", "address")).toBeNull();
    second?.();
    replacement?.();
  });

  it("caps the entire binding at 32 concurrent watches", () => {
    const acquire = createVisitorStreamSlots();
    const releases: (() => void)[] = [];
    for (let index = 0; index < 32; index++) {
      const slot = acquire(
        "binding",
        `visitor-${String(index)}`,
        `address-${String(index)}`,
      );
      expect(slot).not.toBeNull();
      if (slot !== null) releases.push(slot);
    }
    expect(acquire("binding", "overflow", "different-address")).toBeNull();
    releases[0]?.();
    const restored = acquire("binding", "overflow", "different-address");
    expect(restored).not.toBeNull();
    restored?.();
    for (const release of releases) release();
  });

  it("caps each binding and address pair at eight concurrent watches", () => {
    const acquire = createVisitorStreamSlots();
    const releases: (() => void)[] = [];
    for (let index = 0; index < 8; index++) {
      const slot = acquire("binding", `visitor-${String(index)}`, "address");
      expect(slot).not.toBeNull();
      if (slot !== null) releases.push(slot);
    }
    expect(acquire("binding", "overflow", "address")).toBeNull();
    const otherAddress = acquire("binding", "overflow", "other-address");
    const otherBinding = acquire("other-binding", "another", "address");
    expect(otherAddress).not.toBeNull();
    expect(otherBinding).not.toBeNull();
    otherAddress?.();
    otherBinding?.();
    for (const release of releases) release();
  });
});
