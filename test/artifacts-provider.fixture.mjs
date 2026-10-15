// A local Artifacts provider: real bare repositories served by `git http-backend`
// behind the REST envelope the Burrow adapter reads. Only what the git door
// touches is answered: repository info, token minting and smart HTTP.
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const namespace =
  /^\/client\/v4\/accounts\/git-door-proof\/artifacts\/namespaces\/local/u;

export async function artifactsProvider() {
  const root = await mkdtemp(join(tmpdir(), "oyster-git-door-"));
  const tokens = new Set();
  let origin = "";
  const json = (response, status, result) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        status < 300
          ? { success: true, result, errors: [] }
          : {
              success: false,
              result: null,
              errors: [{ code: 10200, message: "Not found" }],
            },
      ),
    );
  };
  const repository = (name) => ({
    id: name,
    name,
    default_branch: "main",
    remote: `${origin}/git/${name}.git`,
    status: "ready",
  });
  const exists = (name) => {
    try {
      execFileSync("git", [
        "--git-dir",
        join(root, `${name}.git`),
        "rev-parse",
      ]);
      return true;
    } catch {
      return false;
    }
  };
  async function backend(request, response, url, body) {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    if (!tokens.has(token)) {
      response.writeHead(401);
      response.end();
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "provider",
        PATH_INFO: url.pathname.slice("/git".length),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
      },
    });
    cgi.stdin.end(body);
    const chunks = [];
    for await (const chunk of cgi.stdout) chunks.push(chunk);
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    const headers = {};
    let status = 200;
    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.end(output.subarray(split + 4));
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://provider");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (url.pathname.startsWith("/git/"))
      return backend(request, response, url, body);
    const path = url.pathname.replace(namespace, "");
    if (path === "/tokens" && request.method === "POST") {
      const { repo } = JSON.parse(body.toString());
      if (!exists(repo)) return json(response, 404);
      const plaintext = `token-${String(tokens.size)}`;
      tokens.add(plaintext);
      return json(response, 200, {
        id: plaintext,
        plaintext,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const name = decodeURIComponent(path.replace(/^\/repos\//u, ""));
    if (request.method === "GET" && path.startsWith("/repos/") && exists(name))
      return json(response, 200, repository(name));
    return json(response, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${String(server.address().port)}`;
  return {
    origin,
    /** Create a provider repository directly, as Burrow's `create` would. */
    create(name) {
      execFileSync("git", [
        "init",
        "--quiet",
        "--bare",
        "--initial-branch=main",
        join(root, `${name}.git`),
      ]);
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
