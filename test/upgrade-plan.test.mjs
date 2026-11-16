import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { execPath } from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

test("an old Worker without /version is unknown and cannot enter upgrade planning", async (t) => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.writeHead(404);
    response.end("Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const child = spawn(
    execPath,
    ["scripts/upgrade-plan.mjs", `http://127.0.0.1:${address.port}/`],
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "close");

  assert.equal(code, 2, stderr);
  assert.match(stderr, /unknown.*STOP/i);
  assert.equal(stdout, "");
  assert.deepEqual(paths, ["/version"]);
});

test("an HTML app response at /version is not a version marker", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<h1>Oyster</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const child = spawn(
    execPath,
    ["scripts/upgrade-plan.mjs", `http://127.0.0.1:${address.port}/`],
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 2, stderr);
  assert.match(stderr, /unknown.*STOP/i);
  assert.equal(stdout, "");
});
