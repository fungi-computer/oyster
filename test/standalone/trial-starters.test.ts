import type { InstallingApp } from "@fungi.computer/nacre/workbench-directory";
import { expect, it } from "vitest";
import {
  createTrialStarters,
  pendingStarters,
  trialStartersBodySchema,
} from "../../src/standalone/trial-starters.js";

const memory = () => {
  let starters: readonly InstallingApp[] | undefined;
  let retries: readonly string[] | undefined;
  return {
    starters: {
      read: () => Promise.resolve(starters),
      write: (value: readonly InstallingApp[]) => {
        starters = value;
        return Promise.resolve();
      },
    },
    retries: {
      read: () => Promise.resolve(retries),
      write: (value: readonly string[]) => {
        retries = value;
        return Promise.resolve();
      },
    },
  };
};

const failed = {
  installationId: "grove",
  displayName: "Grove",
  state: "failed",
  reason: { code: "network", message: "The download stopped." },
} as const;

it("keeps the reported list and clears an App once it is installed", async () => {
  const trial = createTrialStarters(memory());
  await trial.report([
    failed,
    { installationId: "prints", displayName: "Prints", state: "installing" },
  ]);
  const listed = await trial.list();
  expect(listed).toHaveLength(2);
  expect(
    pendingStarters(listed, ["prints"]).map((entry) => entry.installationId),
  ).toEqual(["grove"]);
});

it("remembers a retry for a failed App only, and hands each ask out once", async () => {
  const trial = createTrialStarters(memory());
  await trial.report([
    failed,
    { installationId: "prints", displayName: "Prints", state: "installing" },
  ]);
  expect(await trial.requestRetry("prints")).toBe(false);
  expect(await trial.requestRetry("unknown")).toBe(false);
  expect(await trial.requestRetry("grove")).toBe(true);
  expect(await trial.requestRetry("grove")).toBe(true);
  expect(await trial.takeRetries()).toEqual(["grove"]);
  expect(await trial.takeRetries()).toEqual([]);
});

it("refuses a body outside the contract", () => {
  expect(
    trialStartersBodySchema.safeParse({ installing: [], extra: true }).success,
  ).toBe(false);
  expect(
    trialStartersBodySchema.safeParse({
      installing: [{ installationId: "x", displayName: "X", state: "gone" }],
    }).success,
  ).toBe(false);
  expect(
    trialStartersBodySchema.safeParse({ installing: [failed] }).success,
  ).toBe(true);
});
