import assert from "node:assert/strict";
import type { ShiitakeAgent } from "@fungi.computer/shiitake/client";

/** The same real client commands on Hub and standalone, not a roster-source assertion. */
export async function ordinaryRosterLaw(
  agent: ShiitakeAgent,
  sessionId: string,
) {
  const roster = await agent.extensions.list();
  for (const id of [
    "botanical-session-question",
    "botanical-session-goal",
    "botanical-session-loop",
    "botanical-session-plan",
    "botanical-almanac",
  ])
    assert.equal(
      roster.find((entry) => entry.id === id)?.status,
      "running",
      id,
    );
  for (const [id, command, type] of [
    ["botanical-session-question", "answerFlow", "done"],
    ["botanical-session-goal", "goal", "prompt"],
    ["botanical-session-loop", "loop", "prompt"],
    ["botanical-session-plan", "plan", "done"],
  ]) {
    if (id === undefined || command === undefined)
      throw new Error("Missing law command");
    const extension = agent.session(sessionId).extension(id);
    assert.partialDeepStrictEqual(await extension.call(command, {}), { type });
  }
  const schedule = {
    requestId: "roster-parity",
    sessionId,
    prompt: "Later",
    dueAt: Date.now() + 3_600_000,
  };
  const first = await agent.extensions.call(
    "botanical-almanac",
    "createOneShot",
    schedule,
  );
  assert.deepEqual(
    await agent.extensions.call("botanical-almanac", "createOneShot", schedule),
    first,
  );
  await agent.extensions.call("botanical-almanac", "cancel", {
    scheduleId: schedule.requestId,
  });
}
