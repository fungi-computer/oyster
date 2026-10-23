import {
  nativeLabAppHost,
  nativeAppClient,
} from "./workflow-native.fixture.mjs";
// Standalone Oyster's Computer egress, end to end on a real on-box VM: the
// production root (wrangler dev, landed-push-root.fixture.ts) with real
// Bonsai installed, a real lab vmd Computer, and a guest `git` reaching
// https://oyster.test over the vmd's HTTPS interception -> ComputerDO ->
// OysterComputerEgress -> this Worker's own default export. Hosts outside
// its lanes (origin Git, public package downloads, a live build job's
// internal hosts) must be refused by the same gateway.
//
// Requires OYSTER_PROOF_ENV_FILE (mode 0600) naming an already-running lab
// vmd and the worker slot port it calls back to, as shed-terminal-proof.mjs
// and storyboard.native.mjs do. Claim that slot first.

import { log, error } from "node:console";
import assert from "node:assert/strict";

import { mkdir, writeFile } from "node:fs/promises";

import { URL, fileURLToPath } from "node:url";

import { setTimeout as delay } from "node:timers/promises";

import * as z from "zod";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "../../../../apps/bonsai/backend/methods.ts";
import packageMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };

const appDeclaration = buildAppDeclaration(
  appBackend,
  packageMetadata.fungi.app,
);
const root = fileURLToPath(new URL("../../", import.meta.url));

// Redacted worker log, kept after the run for diagnosis.

const nativeHost = await nativeLabAppHost(root, "computer-egress-native");
const {
  work,
  tenantHost,
  key,
  origin,
  auth,
  redact,
  git: hostGit,
} = nativeHost;

const { call, installFirstParty } = nativeAppClient(origin, auth, {
  key,
  requestMilliseconds: 120_000,
  installationMilliseconds: 120_000,
});

async function installBonsai() {
  await installFirstParty("bonsai", appDeclaration);
}

const timings = {};
try {
  await nativeHost.ready();
  log("step: Oyster ready; installing Bonsai");
  await installBonsai();
  log("step: Bonsai installed; creating pond");
  await call("bonsai", "repos.create", { name: "pond" });
  // One commit from the host, through the same door, so ls-remote has a ref.
  await mkdir(`${work}/checkout`);
  await hostGit("-C", "checkout", "init", "-q", "-b", "main");
  await writeFile(`${work}/checkout/hello.txt`, "hello\n");
  await hostGit("-C", "checkout", "add", "hello.txt");
  await hostGit(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Start pond",
  );
  await hostGit(
    "-C",
    "checkout",
    "-c",
    `http.extraHeader=Authorization: Bearer ${key}`,
    "push",
    "-q",
    `${origin}/git/bonsai/pond.git`,
    "main",
  );
  const head = await hostGit("-C", "checkout", "rev-parse", "HEAD");
  log("step: pond seeded from the host; connecting MCP");

  // The owner reaches the Computer over MCP, as an Agent client does.
  const client = new Client(
    { name: "Oyster Computer egress proof", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler("elicitation/create", () => ({
    action: "accept",
    content: { approve: true },
  }));
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: { headers: auth },
    },
  );
  await client.connect(transport);
  const execute = async (code) => {
    const result = await client.callTool(
      { name: "execute", arguments: { code } },
      { timeout: 240_000 },
    );
    const text = redact(JSON.stringify(result.content));
    assert.notEqual(result.isError, true, text);
    return text;
  };
  // `exec` may be answered by the Worker shell; a process always runs on
  // the hosted backend, here the lab VM, so the guest's own network is used.
  let runs = 0;
  const guest = async (command) => {
    const started = Date.now();
    runs += 1;
    const out = `/workspace/egress-proof-${String(runs)}.txt`;
    log(`step: guest process ${redact(command)}`);
    const startedText = await execute(
      `return await env.computers.workspace.start_process(${JSON.stringify({
        command: `{ ${command}; } > ${out} 2>&1; echo "exit=$?" >> ${out}`,
        cwd: "/workspace",
      })})`,
    );
    const id = /\\"id\\":\\"([^\\"]+)/u.exec(startedText)?.[1];
    assert.ok(id, `No process id: ${startedText}`);
    for (;;) {
      assert.ok(Date.now() - started < 180_000, "Guest process did not exit");
      const listed = await execute(
        "return await env.computers.workspace.list_processes({})",
      );
      if (
        listed.includes(id) &&
        !new RegExp(`${id}[^}]*running`, "u").test(listed)
      )
        break;
      await delay(1_000);
    }
    for (;;) {
      assert.ok(Date.now() - started < 180_000, "Guest output never synced");
      const read = await execute(
        `return (await env.computers.workspace.read(${JSON.stringify({ path: out })})).content`,
      );
      // The tool result is JSON text; decode it back to the file's lines.
      const text = z
        .array(z.object({ text: z.string() }))
        .parse(JSON.parse(read))
        .map((part) => JSON.parse(part.text))
        .join("");
      if (/exit=\d/u.test(text)) return { text, ms: Date.now() - started };
      await delay(1_000);
    }
  };
  try {
    const remote = `https://${tenantHost}/git/bonsai/pond.git`;
    const listed = await guest(
      `git -c "http.extraHeader=Authorization: Bearer ${key}" ls-remote ${remote}`,
    );
    timings.lsRemote = listed.ms;
    assert.match(listed.text, new RegExp(`${head}\\s+refs/heads/main`, "u"));
    assert.match(listed.text, /exit=0/u);
    log(`PASS guest git ls-remote ${remote} -> ${head} (${listed.ms}ms)`);

    // No credential: the egress adds none, so the door challenges.
    const anonymous = await guest(`git ls-remote ${remote}`);
    assert.doesNotMatch(anonymous.text, /exit=0/u);
    assert.doesNotMatch(anonymous.text, new RegExp(head, "u"));
    log("PASS guest git without a credential is challenged by Oyster's door");

    for (const outside of [
      "https://example.com/",
      "https://github.com/git/git.git/info/refs?service=git-upload-pack",
      `https://${tenantHost}/api/installations`,
    ]) {
      const refused = await guest(
        `curl -sS -o /dev/null -w "status=%{http_code}" ${JSON.stringify(outside)}`,
      );
      assert.match(refused.text, /status=403/u, `${outside}: ${refused.text}`);
      log(`PASS guest ${outside} refused by the egress gateway (403)`);
    }
  } finally {
    await transport.terminateSession();
    await client.close();
  }
  assert.match(
    nativeHost.output(),
    /"event":"computer\.egress".*"lane":"origin-git"/u,
    "The gateway recorded the admitted Oyster Git lane",
  );
  log(`PASS computer egress native proof ${JSON.stringify(timings)}`);
} catch (cause) {
  error(redact(nativeHost.output()));
  throw cause;
} finally {
  await nativeHost.close();
}
