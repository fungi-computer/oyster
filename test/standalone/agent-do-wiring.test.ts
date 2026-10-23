import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { expect, it } from "vitest";

import {
  StandaloneAgentBase,
  type StandaloneAgentEnv,
  type StandaloneModelSource,
} from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";

/** The production Agent class, with only its root host and model door filled in. */
class ProbedAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  protected override modelSource(): StandaloneModelSource {
    return {
      acquire: () => Promise.reject(new Error("No model in this test")),
    };
  }
  /** The options the Agent hands Shiitake's Cloudflare host. */
  probe(): Promise<CloudflareShiitakeOptions> {
    return this.shiitakeOptions();
  }
}

function probe(databaseSize: () => number) {
  const env: StandaloneAgentEnv = agentEnv();
  return new ProbedAgent(agentDurableObjectState(databaseSize), env).probe();
}

it("hands Shiitake a storage-pressure check over the Agent's own measured store", async () => {
  let databaseSize = 100_000_000;
  const { storagePressure } = await probe(() => databaseSize);
  if (storagePressure === undefined)
    throw new Error("The Agent passes no storage-pressure check");
  expect(storagePressure.underPressure()).toBe(false);
  databaseSize = 9_000_000_000;
  expect(storagePressure.underPressure()).toBe(true);
});

it("hands Shiitake the Zookeeper patrol, which wakes only over the waterline", async () => {
  let databaseSize = 100_000_000;
  const { hostWork } = await probe(() => databaseSize);
  expect(hostWork).toHaveLength(2);
  const [, patrol] = hostWork ?? [];
  if (patrol === undefined) throw new Error("The Agent passes no patrol");
  expect(patrol.pending().nextWakeAt).toBeNull();
  databaseSize = 6_000_000_000;
  expect(patrol.pending().nextWakeAt).not.toBeNull();
});
