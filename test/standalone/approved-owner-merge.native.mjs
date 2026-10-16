// The installed App's public member door, native GIT binding and real Git objects.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import {
  approvalResult,
  changeDetail,
  checkRequestResult,
  checkReportResult,
  commitDetail,
  mergeResult,
  repoDetail,
} from "../../../../apps/bonsai/shared/contract.ts";

export async function approvedOwnerMerge({
  origin,
  ownerKey,
  agentKey,
  change,
  workingTree,
}) {
  const call = async (name, input, schema, credential = ownerKey) => {
    const response = await globalThis.fetch(
      `${origin}/apps/bonsai/methods/${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    assert.equal(
      response.status,
      200,
      `${name} must succeed through the native owner door`,
    );
    return schema.parse(await response.json());
  };
  const input = { repo: "koi-pond", number: change.number, head: change.head };
  // The caller's `change` can be seed-demo.mjs's trimmed agents-phase
  // receipt ({number, sourceRepo, sourceRef, head, state, status}); read the
  // full record for the fields that shape carries as undefined.
  const opened = (
    await call(
      "changes.get",
      { repo: input.repo, number: input.number },
      changeDetail,
    )
  ).change;
  const attempt = await call(
    "checks.request",
    { ...input, names: ["approved owner TypeScript"] },
    checkRequestResult,
    agentKey,
  );
  assert.equal(attempt.kind, "requested");
  execFileSync(
    fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url)),
    [
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
      "--skipLibCheck",
      "src/main.ts",
    ],
    { cwd: workingTree, stdio: ["ignore", "pipe", "pipe"] },
  );
  const report = await call(
    "checks.report",
    {
      ...input,
      name: "approved owner TypeScript",
      status: "passed",
      attemptId: attempt.attemptId,
    },
    checkReportResult,
    agentKey,
  );
  assert.equal(report.kind, "recorded");
  assert.equal(
    (await call("changes.approve", input, approvalResult)).kind,
    "approved",
  );
  const targetBefore = await call(
    "repos.get",
    { repo: input.repo },
    repoDetail,
  );
  const mainHeadBefore = targetBefore.refs.find(
    (ref) => ref.name === `refs/heads/${opened.targetRef}`,
  )?.hash;
  assert.ok(mainHeadBefore, "The target ref must already carry a head");
  let merged = await call("changes.merge", input, mergeResult);
  if (merged.kind === "merging") {
    // The merge is queued and completes in the background; observe it to a
    // terminal state with a pinned head instead of assuming an immediate
    // kind === "merged".
    let settled = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const polled = await call(
        "changes.get",
        { repo: input.repo, number: input.number },
        changeDetail,
      );
      if (polled.change.state !== "merging") {
        settled = polled.change;
        break;
      }
      await delay(250);
    }
    assert.ok(settled, "A queued merge must reach a terminal state");
    assert.equal(
      settled.state,
      "merged",
      `Approved checked owner head must merge (queued merge settled as ${settled.state}${
        settled.mergeFailure ? `: ${settled.mergeFailure}` : ""
      })`,
    );
    assert.ok(
      settled.mergedCommit,
      "A merged Change must pin its merge commit",
    );
    merged = {
      kind: "merged",
      before: mainHeadBefore,
      after: settled.mergedCommit,
    };
  }
  assert.equal(merged.kind, "merged", "Approved checked owner head must merge");
  const detail = await call(
    "commits.get",
    { repo: input.repo, hash: merged.after },
    commitDetail,
  );
  assert.deepEqual(
    detail.commit.parents,
    [merged.before, change.head],
    "Merge must persist a real two-parent Git commit",
  );
  return merged;
}
