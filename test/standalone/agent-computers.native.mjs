// Real StandaloneAgent with two owner-attached Computers: the Agent's direct
// env.computers.<name> tools reach exactly the named Computer, detach removes
// the authority, and reattaching mints new authority. No provider: only the
// model is a deterministic fixture. Run with node, or pinned celld.
/* global fetch, AbortSignal, Request */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import {
  nativeAppClient,
  nativeWorkflowRoot,
  until,
} from "./workflow-native.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim()}`;

await test("an Agent's attached Computers are independent, explicit and revocable", async (t) => {
  const host = await nativeWorkflowRoot({
    root,
    prefix: "agent-computers-",
    main: "agent-computers.native.fixture.ts",
    artifactBucket: "agent-computers-artifacts",
    computer: null,
  });
  let client;
  try {
    await host.ready();
    // Grove is the installed App whose owner-approved capability carries the
    // Agent's Session transport; the Computers themselves need no App.
    const grove = standaloneAppSet.find(
      (app) => app.installationId === "grove",
    );
    assert.ok(grove, "the maintained App set includes Grove");
    const directory = `${host.work}/grove-release`;
    await packRelease({
      appId: grove.appId,
      releaseId: "rel_pairedgrove",
      sourceDirectory: repository,
      sourceRevision,
      packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      recipe: committedAppRecipe(repository, grove, sourceRevision.slice(4)),
      outDirectory: directory,
    });
    const installed = await installRelease({
      directory,
      url: host.origin,
      key: host.key,
      installationId: "grove",
    });
    assert.equal(installed.status, 201, "Grove installation");
    await nativeAppClient(host.origin, host.auth, { key: host.key }).approve(
      "grove",
    );
    const headers = {
      ...host.auth,
      "Content-Type": "application/json",
      "X-Oyster-Installation": "grove",
    };
    const owner = async (path, body) => {
      const response = await fetch(`${host.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(
        response.status,
        200,
        `${path}: ${await response.clone().text()}`,
      );
      return response.json();
    };
    const { agentId } = await owner("/agents", {
      name: "Pair",
      requestId: "pair-agent",
    });
    const computers = {};
    for (const name of ["Amber", "Birch"])
      computers[name] = (
        await owner("/api/computers", { name, requestId: `create-${name}` })
      ).computerId;
    let sequence = 0;
    const attach = (name, attachmentId) =>
      owner(`/api/agents/${agentId}/computers/attach`, {
        agentId,
        attachmentId,
        computerId: computers[name],
        requestId: `attach-${attachmentId}-${(sequence += 1)}`,
      });
    const detach = (name, attachmentId) =>
      owner(`/api/agents/${agentId}/computers/detach`, {
        agentId,
        attachmentId,
        computerId: computers[name],
        requestId: `detach-${attachmentId}-${(sequence += 1)}`,
      });
    const projection = await attach("Amber", "att-amber");
    await attach("Birch", "att-birch");
    assert.equal(projection.attachments.length, 1);

    client = createShiitakeClient({
      baseUrl: `${host.origin}/agents/${agentId}`,
      fetch: (input, init) => {
        const request = new Request(input, init);
        for (const [name, value] of Object.entries(headers))
          request.headers.set(name, value);
        return fetch(request);
      },
    });
    const session = client.session(await client.createSession("pair-session"));
    let turn = 0;
    /** One owner turn: the fixture model runs this program through `execute`. */
    const run = async (program) => {
      turn += 1;
      const accepted = await session.send(
        `turn ${turn}\n\`\`\`js\n${program}\n\`\`\``,
      );
      const settled = await until(
        () => session.read(),
        (read) =>
          read.terminals.some(
            ({ commandId }) => commandId === accepted.commandId,
          ),
        `turn ${turn} settles`,
      );
      const result = settled.messages
        .map(({ value }) => value)
        .filter((value) => value.role === "toolResult")
        .at(-1);
      assert.ok(result, `turn ${turn} ran a tool`);
      const text = result.content.map((part) => part.text ?? "").join("");
      return { isError: result.isError === true, text };
    };
    const value = async (program) => {
      const { isError, text } = await run(program);
      assert.equal(isError, false, text);
      return JSON.parse(text);
    };
    const keys = () => value("return Object.keys(env.computers).sort()");
    const named = (pattern) => async () =>
      (await keys()).find((name) => pattern.test(name));
    const nameA = await named(/amber/iu)();
    const nameB = await named(/birch/iu)();

    await t.test(
      "both Computers are named; no implicit Home exists",
      async () => {
        assert.ok(nameA && nameB, JSON.stringify(await keys()));
        assert.deepEqual(
          (await keys()).filter((n) => /^(home|workspace)$/iu.test(n)),
          [],
          "the Agent has no implicit Home Computer",
        );
      },
    );

    /** write, read, glob, edit and execute against one named Computer. */
    const operate = (name, who) => `
const c = env.computers[${JSON.stringify(name)}];
const before = await c.exec({command: "ls /workspace", cwd: "/workspace", timeoutMs: 30000});
await c.write({path: "/workspace/who.txt", content: "I am ${who}\\n"});
const read = await c.read({path: "/workspace/who.txt"});
const found = await c.files.glob({path: "/workspace", pattern: "who*.txt"});
await c.files.edit({path: "/workspace/who.txt", oldText: "I am ${who}", newText: "I am ${who} patched"});
const ran = await c.exec({command: "cat /workspace/who.txt", cwd: "/workspace", timeoutMs: 30000});
return {before, read, found, ran};`;
    await t.test(
      "read/find/edit/execute reach exactly the named Computer",
      async () => {
        const a = await value(operate(nameA, "A"));
        const b = await value(operate(nameB, "B"));
        assert.match(JSON.stringify(a.read), /I am A/u);
        assert.match(JSON.stringify(a.found), /who\.txt/u);
        assert.match(a.ran.output.stdout, /I am A patched/u);
        assert.doesNotMatch(
          b.before.output.stdout,
          /who\.txt/u,
          "A's file never appeared on B",
        );
        assert.match(b.ran.output.stdout, /I am B patched/u);
        assert.doesNotMatch(b.ran.output.stdout, /I am A/u);
        const again = await value(
          `const c = env.computers[${JSON.stringify(nameA)}]; return await c.exec({command: "cat /workspace/who.txt", cwd: "/workspace", timeoutMs: 30000});`,
        );
        assert.match(
          again.output.stdout,
          /I am A patched/u,
          "B's patch never touched A",
        );
      },
    );

    await t.test(
      "detach removes exactly that authority; reattach mints new",
      async () => {
        await detach("Birch", "att-birch");
        const remaining = await keys();
        assert.deepEqual(
          remaining.filter((n) => /birch/iu.test(n)),
          [],
          "a detached Computer is no longer a tool",
        );
        assert.equal(remaining.filter((n) => /amber/iu.test(n)).length, 1);
        const callDetached = await run(
          `return await env.computers[${JSON.stringify(nameB)}].exec({command: "true", cwd: "/workspace", timeoutMs: 30000})`,
        );
        assert.equal(
          callDetached.isError,
          true,
          "a call to the detached name fails",
        );
        // Reattaching the old identity is a new admission: its version moves
        // past every captured one, so held authority cannot follow it.
        const before = (
          await owner(`/api/agents/${agentId}/computers/read`, { agentId })
        ).attachments.find((row) => row.computerId === computers.Amber);
        const revived = (await attach("Birch", "att-birch")).attachments.find(
          (row) => row.computerId === computers.Birch,
        );
        assert.ok(before && revived);
        assert.ok(revived.version > 1, JSON.stringify(revived));
        assert.ok(
          await named(/birch/iu)(),
          "a fresh attachment names it again",
        );
        const files = await value(
          `return await env.computers[${JSON.stringify(nameB)}].exec({command: "cat /workspace/who.txt", cwd: "/workspace", timeoutMs: 30000})`,
        );
        assert.match(
          files.output.stdout,
          /I am B patched/u,
          "the Computer's own data persists",
        );
      },
    );

    await t.test(
      "Home is explicit: with nothing attached the Agent has no Computer",
      async () => {
        await detach("Amber", "att-amber");
        await detach("Birch", "att-birch");
        assert.deepEqual(
          await value(
            "return env.computers === undefined ? [] : Object.keys(env.computers)",
          ),
          [],
        );
      },
    );
  } finally {
    try {
      await client?.close();
    } finally {
      await host.close();
    }
  }
});
