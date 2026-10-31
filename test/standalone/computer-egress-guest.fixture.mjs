// Shared guest boundary for the native and browser egress qualifications.
// The owner selects a Computer, MCP starts a real container process, and the
// public package request crosses the same production egress door.
import { log } from "node:console";
import assert from "node:assert/strict";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  computerProcessSchema,
  processListOutputSchema,
} from "@fungi.computer/computer-contract";
import { teamComputerSchema } from "@fungi.computer/nacre/workbench";

let runs = 0;

/** The owner selects the Computer before acquiring a fresh MCP catalog. */
export async function connectGuest(host, computerId) {
  const { origin, auth, redact } = host;
  const selected = await globalThis.fetch(`${origin}/api/computers/selected`, {
    method: "PUT",
    headers: {
      ...auth,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ computerId }),
  });
  assert.equal(selected.status, 200, await selected.clone().text());
  assert.equal(
    teamComputerSchema.parse(await selected.json()).computerId,
    computerId,
  );
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
    { requestInit: { headers: auth } },
  );
  await client.connect(transport);
  const execute = async (code) => {
    const result = await client.callTool(
      { name: "execute", arguments: { code } },
      { timeout: 240_000 },
    );
    assert.notEqual(
      result.isError,
      true,
      redact(JSON.stringify(result.content)),
    );
    const [part] = z
      .tuple([z.object({ type: z.literal("text"), text: z.string() })])
      .parse(result.content);
    return JSON.parse(part.text);
  };
  // A process uses the container backend, not the Worker's builtin shell.
  const guest = async (command) => {
    const started = Date.now();
    runs += 1;
    const out = `/workspace/egress-proof-${String(runs)}.txt`;
    log(`step: ${computerId} guest process ${redact(command)}`);
    const process = computerProcessSchema.parse(
      await execute(
        `return await env.computers.workspace.start_process(${JSON.stringify({
          command: `{ ${command}; } > ${out} 2>&1; echo "exit=$?" >> ${out}`,
          cwd: "/workspace",
        })})`,
      ),
    );
    for (;;) {
      assert.ok(Date.now() - started < 180_000, "Guest process did not exit");
      const listed = processListOutputSchema.parse(
        await execute(
          "return await env.computers.workspace.list_processes({})",
        ),
      );
      const current = listed.processes.find(({ id }) => id === process.id);
      if (current !== undefined && current.state !== "running") break;
      await delay(1_000);
    }
    for (;;) {
      assert.ok(Date.now() - started < 180_000, "Guest output never synced");
      const text = z
        .string()
        .parse(
          await execute(
            `return (await env.computers.workspace.read(${JSON.stringify({ path: out })})).content`,
          ),
        );
      if (/exit=\d/u.test(text)) return { text, ms: Date.now() - started };
      await delay(1_000);
    }
  };
  return {
    guest,
    async close() {
      await transport.terminateSession();
      await client.close();
    },
  };
}

export async function expectPublicDownload(host, computerId, status) {
  const connection = await connectGuest(host, computerId);
  try {
    const result = await connection.guest(
      [
        "status=$(curl -sS -o /tmp/egress-package.tgz -w '%{http_code}' https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz)",
        'printf "status=%s\\n" "$status"',
        `if [ "$status" = 200 ]; then tar -xOf /tmp/egress-package.tgz package/package.json | node -p "JSON.parse(require('node:fs').readFileSync(0, 'utf8')).version"; fi`,
      ].join(" && "),
    );
    assert.match(result.text, new RegExp(`status=${status}`, "u"));
    assert.match(result.text, /exit=0/u);
    if (status === 200) assert.match(result.text, /7\.0\.0/u);
    log(`PASS ${computerId} public package download: ${status}`);
  } finally {
    await connection.close();
  }
}
