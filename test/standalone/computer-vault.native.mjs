// The Vault lane end to end on standalone Oyster: a real StandaloneAgent
// Session (only the model is a deterministic fixture) runs bash on real local
// platform containers, whose HTTPS goes through the production
// OysterComputerEgress, the Computer's own `fvr1.` references and the Agent
// directory's sealed Veil custody. The one bound API is a fake echo upstream
// answering the Worker's own fetch (computer-vault.native.fixture.ts).
//
//   (a) env, printenv, /proc/self/environ and the disk show only references
//   (b) an unlisted host is refused and audited refused_destination
//   (c) the bound host on a wrong path or method is refused
//   (d) an echoing upstream's body arrives redacted, audited echo_redacted
//   (e) a redirect is not followed with the credential
//   (f) a reference copied to another Computer, or kept past its command, is inert
//   (g) revoke refuses the next request of a still-running command
//   (h) the value is absent from the transcript, the logs and the disk
/* global fetch, AbortSignal, Request, console */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { installRelease, packRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import { labComputer } from "./lab-computer.fixture.mjs";
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
const echoHost = "vault-echo.fungi.computer";
/** Disk and output scans look for this marker, never the whole value. */
const marker = "VAULTCANARY_";
const canary = `sk_test_${marker}${randomBytes(16).toString("hex")}`;
const referencePattern = /fvr1\.[A-Za-z0-9_-]{43}/u;

await test("Vault references: only bound sites get the key; the Agent never sees it", async (t) => {
  const host = await nativeWorkflowRoot({
    root,
    prefix: "computer-vault-native-",
    main: "computer-vault.native.fixture.ts",
    artifactBucket: "computer-vault-native-artifacts",
    // The claimed on-box VM when OYSTER_PROOF_ENV_FILE names one, else the
    // local platform container.
    computer: (await labComputer({ required: false })) ?? "platform-container",
    computerInstances: 2,
    // The Vault seals values only under the instance key.
    variables: { OYSTER_CREDENTIAL_KEY: randomBytes(32).toString("base64url") },
  });
  let client;
  try {
    try {
      await host.ready();
    } catch (cause) {
      console.error(host.redact(host.output()).slice(-6000));
      throw cause;
    }
    // Grove carries the Agent's Session transport, as in agent-computers.
    const grove = standaloneAppSet.find(
      (app) => app.installationId === "grove",
    );
    assert.ok(grove, "the maintained App set includes Grove");
    const directory = `${host.work}/grove-release`;
    await packRelease({
      appId: grove.appId,
      releaseId: "rel_vaultgrove",
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
    const post = async (path, body) => {
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
    const { agentId } = await post("/agents", {
      name: "Vault",
      requestId: "vault-agent",
    });
    const computers = {};
    for (const name of ["Amber", "Birch"])
      computers[name] = (
        await post("/api/computers", { name, requestId: `create-${name}` })
      ).computerId;
    for (const name of ["Amber", "Birch"])
      await post(`/api/agents/${agentId}/computers/attach`, {
        agentId,
        attachmentId: `att-${name}`,
        computerId: computers[name],
        requestId: `attach-${name}`,
      });
    const { connectionId } = await post("/vault-proof/secret", {
      name: "STRIPE_KEY",
      secret: canary,
      agentId,
    });

    client = createShiitakeClient({
      baseUrl: `${host.origin}/agents/${agentId}`,
      fetch: (input, init) => {
        const request = new Request(input, init);
        for (const [name, value] of Object.entries(headers))
          request.headers.set(name, value);
        return fetch(request);
      },
    });
    const session = client.session(await client.createSession("vault"));
    let turn = 0;
    /** One owner turn: the fixture model runs this program through `execute`. */
    const value = async (code) => {
      turn += 1;
      const accepted = await session.send(
        `turn ${turn}\n\`\`\`js\n${code}\n\`\`\``,
      );
      const settled = await until(
        () => session.read(),
        (read) =>
          read.terminals.some(
            ({ commandId }) => commandId === accepted.commandId,
          ),
        `turn ${turn} settles`,
        300_000,
      );
      const result = settled.messages
        .map(({ value }) => value)
        .filter((value) => value.role === "toolResult")
        .at(-1);
      assert.ok(result, `turn ${turn} ran a tool`);
      const text = result.content.map((part) => part.text ?? "").join("");
      assert.notEqual(result.isError, true, text);
      return JSON.parse(text);
    };
    const keys = await value("return Object.keys(env.computers).sort()");
    const computerName = (pattern) => {
      const found = keys.find((name) => pattern.test(name));
      assert.ok(found, JSON.stringify(keys));
      return found;
    };
    const amber = computerName(/amber/iu);
    const birch = computerName(/birch/iu);
    /** One Agent bash command on a named Computer. */
    const bash = async (name, command) =>
      (
        await value(
          `return await env.computers[${JSON.stringify(name)}].bash(${JSON.stringify(
            { command, cwd: "/workspace", timeoutMs: 120_000 },
          )});`,
        )
      ).output;
    const status = (url, extra = "") =>
      `curl -sS -o /dev/null -w "%{http_code}" ${extra} -H "Authorization: Bearer $STRIPE_KEY" ${JSON.stringify(url)}`;
    const usage = () => post("/vault-proof/usage", { connectionId, agentId });
    const upstream = () => post("/vault-proof/upstream");
    const diskScan = `grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev ${marker} / 2>/dev/null | head -5; echo scanned`;

    let firstReference = "";
    await t.test(
      "(a) the Agent's env, /proc and disk hold only a reference",
      async () => {
        const output = await bash(
          amber,
          [
            'echo "key=$STRIPE_KEY"',
            "printenv | grep '^STRIPE_KEY='",
            // A fresh process: its /proc/self/environ is what execve gave it.
            "sh -c 'xargs -0 -n1 echo < /proc/self/environ' | grep '^STRIPE_KEY='",
            diskScan,
          ].join("; "),
        );
        const reference = referencePattern.exec(output.stdout)?.[0];
        assert.ok(reference, output.stdout);
        firstReference = reference;
        assert.equal(
          output.stdout.split(reference).length - 1,
          3,
          output.stdout,
        );
        assert.doesNotMatch(output.stdout, new RegExp(marker, "u"));
        assert.match(output.stdout, /^scanned$/mu, "no file holds the value");
      },
    );

    await t.test("(b) an unlisted host is refused and audited", async () => {
      const output = await bash(
        amber,
        status("https://example.com/v1/charges"),
      );
      assert.equal(output.stdout.trim(), "403");
      assert.ok(
        (await usage()).some(
          (row) => row.outcome === "refused_destination" && row.host === null,
        ),
      );
    });

    await t.test(
      "(c) a bound host on a wrong path or method is refused",
      async () => {
        const output = await bash(
          amber,
          [
            status(`https://${echoHost}/v2/charges`),
            "echo",
            status(`https://${echoHost}/v1/charges`, "-X DELETE"),
          ].join("; "),
        );
        assert.deepEqual(output.stdout.trim().split(/\s+/u), ["403", "403"]);
        assert.deepEqual(
          await upstream(),
          [],
          "nothing reached the bound host",
        );
      },
    );

    await t.test(
      "(d) an echoing upstream's body arrives redacted",
      async () => {
        const output = await bash(
          amber,
          `curl -sS -D /workspace/echo.headers -o /workspace/echo.json -H "Authorization: Bearer $STRIPE_KEY" https://${echoHost}/v1/echo; cat /workspace/echo.json; echo; cat /workspace/echo.headers; ${diskScan}`,
        );
        assert.match(
          output.stdout,
          /\[REDACTED\]/u,
          JSON.stringify(await usage()),
        );
        assert.doesNotMatch(output.stdout, new RegExp(marker, "u"));
        assert.doesNotMatch(output.stdout, /x-echo/iu);
        assert.match(output.stdout, /^scanned$/mu);
        assert.deepEqual(await upstream(), [
          { path: "/v1/echo", placed: true },
        ]);
        assert.ok(
          (await usage()).some((row) => row.outcome === "echo_redacted"),
        );
      },
    );

    await t.test(
      "(e) a redirect is not followed with the credential",
      async () => {
        const output = await bash(
          amber,
          status(`https://${echoHost}/v1/redirect`, "-L"),
        );
        assert.equal(output.stdout.trim(), "502");
        assert.deepEqual(
          (await upstream()).map(({ path }) => path),
          ["/v1/echo", "/v1/redirect"],
        );
      },
    );

    await t.test("(f) a copied or outlived reference is inert", async () => {
      const copied = `curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${firstReference}" https://${echoHost}/v1/copied`;
      const elsewhere = await bash(birch, copied);
      assert.equal(elsewhere.stdout.trim(), "403", "another Computer");
      const later = await bash(amber, copied);
      assert.equal(later.stdout.trim(), "403", "after its command ended");
      assert.ok(!(await upstream()).some(({ path }) => path === "/v1/copied"));
    });

    await t.test(
      "(g) revoke refuses the next request without a restart",
      async () => {
        const running = bash(
          amber,
          `${status(`https://${echoHost}/v1/before`)}; echo; sleep 25; ${status(`https://${echoHost}/v1/after`)}`,
        );
        await until(
          upstream,
          (rows) => rows.some(({ path }) => path === "/v1/before"),
          "the first request is placed",
          180_000,
        );
        await post("/vault-proof/revoke", { connectionId, agentId });
        const output = await running;
        assert.deepEqual(output.stdout.trim().split(/\s+/u), ["200", "403"]);
        assert.ok(!(await upstream()).some(({ path }) => path === "/v1/after"));
        assert.ok(
          (await usage()).some((row) => row.outcome === "refused_grant"),
        );
      },
    );

    await t.test(
      "(h) the value is absent from transcript, logs and disk",
      async () => {
        for (const name of [amber, birch]) {
          const output = await bash(name, diskScan);
          assert.match(output.stdout, /^scanned$/mu, name);
          assert.doesNotMatch(output.stdout, new RegExp(marker, "u"));
        }
        const transcript = JSON.stringify(await session.read());
        assert.ok(!transcript.includes(canary), "transcript");
        assert.ok(!host.output().includes(canary), "Worker logs");
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
