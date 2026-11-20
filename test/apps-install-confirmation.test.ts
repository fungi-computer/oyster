import { expect, it } from "vitest";
import { installConfirmation } from "../src/apps/install-confirmation.js";
import { permissionCatalog } from "../src/apps/catalog.js";

it("lists every declared permission once across a bulk install and confirms what an owner install grants", () => {
  const confirmation = installConfirmation("owner", [
    { name: "Notes", capabilities: ["app.storage", "agent.list"] },
    { name: "Board", capabilities: ["agent.list", "app.storage"] },
  ]);
  expect(confirmation.granted.map(({ capability }) => capability)).toEqual([
    "app.storage",
    "agent.list",
  ]);
  expect(confirmation.granted[1]?.apps).toEqual(["Notes", "Board"]);
  expect(confirmation.granted[1]?.label).toBe(
    permissionCatalog["agent.list"].label,
  );
  expect(confirmation.needsApproval).toEqual([]);
});

it("keeps an ask-class permission out of an owner's granted list", () => {
  const confirmation = installConfirmation("owner", [
    { name: "Reviewer", capabilities: ["approvals", "app.storage"] },
  ]);
  expect(confirmation.granted.map(({ capability }) => capability)).toEqual([
    "app.storage",
  ]);
  expect(
    confirmation.needsApproval.map(({ capability }) => capability),
  ).toEqual(["approvals"]);
});

it("grants a member only App storage and leaves the rest waiting for an owner", () => {
  const confirmation = installConfirmation("member", [
    { name: "Notes", capabilities: ["app.storage", "agent.list"] },
  ]);
  expect(confirmation.granted.map(({ capability }) => capability)).toEqual([
    "app.storage",
  ]);
  expect(
    confirmation.needsApproval.map(({ capability }) => capability),
  ).toEqual(["agent.list"]);
});
