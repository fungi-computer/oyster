import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { instanceIds } from "../dist/index.js";
import process from "node:process";
import console from "node:console";

const directory = fileURLToPath(new URL("./", import.meta.url));
await mkdir(fileURLToPath(new URL("../.botanical/", import.meta.url)), {
  recursive: true,
});
const state = await mkdtemp(
  fileURLToPath(new URL("../.botanical/loader-native-", import.meta.url)),
);
const port = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const worker = spawn(
  fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url)),
  [
    "dev",
    "--config",
    `${directory}loader-cache.config.jsonc`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    state,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
if (process.env.CELLD_PLATFORM_CELLD)
  assert.equal(
    worker.spawnfile,
    process.env.CELLD_PLATFORM_CELLD,
    "actual pinned celld was launched",
  );
let output = "";
worker.stdout.on("data", (value) => {
  output += value;
  process.stdout.write(value);
});
worker.stderr.on("data", (value) => {
  output += value;
  process.stderr.write(value);
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await globalThis.fetch(`http://127.0.0.1:${port}`, {
        signal: globalThis.AbortSignal.timeout(3000),
      });
      ready = true;
      break;
    } catch (cause) {
      if (worker.exitCode !== null || attempt === 119) throw cause;
      await delay(500);
    }
  }
  assert.ok(ready, "native runtime readiness");
  const instanceId = instanceIds.instance.generate();
  const send = async (input) => {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId, ...input }),
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    assert.equal(
      response.status,
      200,
      response.status === 200 ? "" : (await response.text()).slice(0, 500),
    );
    return response.json();
  };
  if (process.argv.includes("--budget-reset")) {
    let previous;
    for (const actor of ["budget-A", "budget-B"]) {
      const exhausted = await send({
        actor,
        mode: "budget-subrequests-exhaust",
        budget: "subrequests",
      });
      assert.equal(exhausted.status, 200, JSON.stringify(exhausted));
      assert.equal(exhausted.result.actor, actor);
      assert.equal(
        exhausted.result.budgetWork,
        12,
        "twelve counted fetches succeed in each frame",
      );
      assert.equal(
        exhausted.result.budgetError,
        "Worker exceeded subrequest limit of 12",
        "the next fetch fails with the runtime limit error",
      );
      if (previous) {
        assert.equal(
          exhausted.result.moduleId,
          previous.moduleId,
          "same cached code across exhausted frames",
        );
        assert.notEqual(
          exhausted.result.frameId,
          previous.frameId,
          "fresh frame authority and allowance",
        );
      }
      previous = exhausted.result;
    }
    console.log(
      "PASS counted fetch budget: A exhausts; fresh B gets twelve and independently exhausts on the same cached module",
    );
  } else {
    const ordinary = await send({ actor: "ordinary", mode: "normal" });
    assert.equal(ordinary.status, 200, JSON.stringify(ordinary));
    assert.equal(ordinary.result.actor, "ordinary", JSON.stringify(ordinary));
    console.log("PASS ordinary production binding without CONTROL calls");
    const late = await send({ actor: "late_A", mode: "late" });
    assert.equal(late.status, 200, JSON.stringify(late));
    assert.equal(late.result.actor, "late_A", JSON.stringify(late));
    assert.deepEqual(late.effects, {});
    const next = await send({ actor: "late_B", mode: "wait" });
    assert.equal(next.status, 200, JSON.stringify(next));
    assert.equal(next.result.actor, "late_B", JSON.stringify(next));
    assert.equal(
      next.result.moduleId,
      late.result.moduleId,
      "compiled module retained",
    );
    assert.notEqual(next.result.frameId, late.result.frameId);
    assert.equal(next.result.denied, true, "retained A stub refused during B");
    assert.equal(
      next.result.deniedCode,
      "revoked",
      "guest receives typed local refusal",
    );
    assert.equal(
      next.packetRefusal,
      "revoked",
      "retained packet receives typed host refusal",
    );
    assert.deepEqual(next.effects, { "B-control": 1 });
    assert.deepEqual(next.actors, { "B-control": "late_B" });
    console.log(
      "PASS native facade, frame stubs, cached module, production late-work guard",
    );
  }
} catch (cause) {
  console.error(output);
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await rm(state, { recursive: true, force: true });
}
