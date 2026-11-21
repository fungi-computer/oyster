import { expect, it } from "vitest";
import { extensionChoices } from "../../src/standalone/agent-extension-attachments.js";

const notes = {
  installationId: "notes",
  instanceId: "instance-1",
  name: "Notes",
};
const garden = {
  installationId: "garden",
  instanceId: "instance-2",
  name: "Garden",
};

it("splits the candidates into those attached and those the owner could attach, by name", () => {
  expect(
    extensionChoices(
      "agent_1",
      [notes, garden],
      [{ installationId: "notes", instanceId: "instance-1" }],
    ),
  ).toEqual({
    agentId: "agent_1",
    attached: [{ installationId: "notes", name: "Notes" }],
    available: [{ installationId: "garden", name: "Garden" }],
  });
});

it("reads an attachment as lapsed when its installation was replaced or is no longer a candidate", () => {
  // The installation now runs a new Instance: the old attachment pinned the old one.
  expect(
    extensionChoices(
      "agent_1",
      [{ ...notes, instanceId: "instance-9" }],
      [{ installationId: "notes", instanceId: "instance-1" }],
    ),
  ).toEqual({
    agentId: "agent_1",
    attached: [],
    available: [{ installationId: "notes", name: "Notes" }],
  });
  // The installation was removed, disabled or is no longer an extension.
  expect(
    extensionChoices(
      "agent_1",
      [],
      [{ installationId: "notes", instanceId: "instance-1" }],
    ),
  ).toEqual({ agentId: "agent_1", attached: [], available: [] });
});
