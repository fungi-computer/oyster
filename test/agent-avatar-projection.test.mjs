import assert from "node:assert/strict";
import { test } from "node:test";
import { seededAvatar } from "@fungi.computer/sprite/avatar";
import {
  agentAvatarProjectionSchema,
  avatarFromProjection,
} from "../dist/agent-avatars.js";

// The closed-record avatar projection is built on first use, not when the
// Worker starts (constructing it cost ~20 ms of startup CPU). Deferring it must
// not change what it accepts.

test("the projection schema is deferred until it is first used", () => {
  assert.equal(agentAvatarProjectionSchema._zod.def.type, "lazy");
});

test("a seeded avatar passes the projection and comes back as the Avatar", () => {
  const avatar = seededAvatar("agent-garden");
  const projected = agentAvatarProjectionSchema.parse(avatar);
  assert.deepEqual(avatarFromProjection(projected), avatar);
});

test("the projection stays closed: an appearance naming a control the character lacks is refused", () => {
  const avatar = seededAvatar("agent-garden");
  const result = agentAvatarProjectionSchema.safeParse({
    ...avatar,
    appearance: { ...avatar.appearance, notAControl: "x" },
  });
  assert.equal(result.success, false);
});
