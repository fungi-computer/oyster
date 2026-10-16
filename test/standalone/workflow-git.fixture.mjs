import { createServer } from "node:http";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { URL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as z from "zod";
import { realGit } from "@fungi.computer/agar/test-kit/git";

// Actual git objects, refs and smart HTTP; only the provider's REST envelope
// is local. This does not implement or replace Workflow publication.
//
// Every namespace names the same repositories. Namespace `local` advertises
// this server's own Git remotes, which a Worker's ordinary fetch reaches.
// Any other namespace advertises Cloudflare's remote shape, which the
// maintained Artifacts owner requires; its caller supplies the Git transport
// mapping that host back to this server (`workflows-root.fixture.ts`).
export const providerRemoteHost = "workflow-proof.artifacts.cloudflare.net";
export async function workflowGitProvider() {
  const fixture = realGit();
  const names = new Set();
  // Fork lineage, as Artifacts reports it: the repository each fork copied.
  const sources = new Map();
  const requests = [];
  const tokens = new Map();
  let origin;
  const info = async (name, namespace) => {
    const found = await fixture.git.info(name);
    return (
      found && {
        id: name,
        name,
        default_branch: found.defaultBranch,
        remote:
          namespace === "local"
            ? `${origin}/git/${name}.git`
            : `https://${providerRemoteHost}/git/${namespace}/${name}.git`,
        source: sources.has(name)
          ? `artifacts:${namespace}/${sources.get(name)}`
          : null,
        status: "ready",
      }
    );
  };
  const respond = async (request, response) => {
    const url = new URL(request.url, "http://local");
    requests.push(`${request.method} ${url.pathname}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const json = (result, resultInfo = null) => {
      response.setHeader("content-type", "application/json");
      const body = { success: true, result, errors: [] };
      if (resultInfo !== null) body.result_info = resultInfo;
      response.end(JSON.stringify(body));
    };
    const missing = () => {
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          success: false,
          result: null,
          errors: [{ code: 10200, message: "Not found" }],
        }),
      );
    };
    if (url.pathname.startsWith("/git/")) {
      const match =
        /^\/git\/(?:[a-z0-9-]+\/)?([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(
          url.pathname,
        );
      if (!match) return missing();
      const name = z.string().parse(match[1]);
      const service = (url.searchParams.get("service") ?? match[2]).replace(
        "git-",
        "",
      );
      const result = await fixture.git.exchange(name, {
        service: z.enum(["upload-pack", "receive-pack"]).parse(service),
        phase: match[2] === "info/refs" ? "advertise" : "exchange",
        body: match[2] === "info/refs" ? null : bytes,
        headers: Object.fromEntries(
          Object.entries(request.headers).flatMap(([key, value]) => {
            const parsed = z
              .union([
                z.string(),
                z.array(z.string()).transform((values) => values.join(",")),
              ])
              .optional()
              .parse(value);
            return parsed === undefined ? [] : [[key, parsed]];
          }),
        ),
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }
    const scoped =
      /^\/client\/v4\/accounts\/workflow-proof\/artifacts\/namespaces\/([a-z0-9-]+)(\/.*)$/u.exec(
        url.pathname,
      );
    const namespace = scoped ? z.string().parse(scoped[1]) : "local";
    const path = scoped ? z.string().parse(scoped[2]) : url.pathname;
    /** A created repository answers with its info and one initial token. */
    const created = async (name) => {
      names.add(name);
      tokens.set(`${name}-initial`, { repo: name, state: "active" });
      return json({
        ...(await info(name, namespace)),
        token: `${name}-initial`,
      });
    };
    if (path === "/tokens" && request.method === "POST") {
      const body = z
        .object({
          repo: z.string(),
          scope: z.enum(["read", "write"]),
          ttl: z.number().positive(),
        })
        .parse(JSON.parse(bytes.toString()));
      if (!names.has(body.repo)) return missing();
      const id = `${body.repo}-${body.scope}-${String(tokens.size)}`;
      tokens.set(id, { repo: body.repo, state: "active" });
      return json({
        id,
        plaintext: id,
        expires_at: new Date(Date.now() + body.ttl * 1000).toISOString(),
      });
    }
    if (path.startsWith("/tokens/") && request.method === "DELETE") {
      const token = tokens.get(
        decodeURIComponent(path.slice("/tokens/".length)),
      );
      if (!token) return missing();
      token.state = "revoked";
      return json({});
    }
    if (path === "/repos" && request.method === "POST") {
      const body = z
        .object({ name: z.string(), default_branch: z.string() })
        .parse(JSON.parse(bytes.toString()));
      await fixture.git.create(body.name, {
        defaultBranch: body.default_branch,
      });
      return created(body.name);
    }
    if (path === "/repos")
      return json(
        await Promise.all([...names].map((name) => info(name, namespace))),
      );
    const [, , rawName, operation, hash] = path.split("/");
    const name = decodeURIComponent(rawName ?? "");
    if (!(await fixture.git.info(name))) return missing();
    if (operation === undefined) {
      if (request.method === "DELETE") {
        await fixture.git.delete(name);
        names.delete(name);
        sources.delete(name);
        return json({});
      }
      return json(await info(name, namespace));
    }
    if (operation === "tokens" && request.method === "GET") {
      const listed = [...tokens]
        .filter(([, token]) => token.repo === name)
        .map(([id, token]) => ({ id, state: token.state }));
      return json(listed, { total_pages: 1, total_count: listed.length });
    }
    if (operation === "fork" && request.method === "POST") {
      const body = z
        .object({ name: z.string() })
        .parse(JSON.parse(bytes.toString()));
      await fixture.git.create(body.name, { defaultBranch: "main" });
      if ((await fixture.git.refs(name)).length > 0)
        execFileSync(
          "git",
          [
            "-C",
            fileURLToPath(await fixture.git.cloneUrl(name)),
            "push",
            "--quiet",
            fileURLToPath(await fixture.git.cloneUrl(body.name)),
            "--all",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      sources.set(body.name, name);
      return created(body.name);
    }

    if (operation === "log")
      return json(
        await fixture.git.log(name, {
          ref: url.searchParams.get("ref") ?? "main",
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      );
    if (operation === "commit") {
      const value = await fixture.git.readCommit(name, hash);
      return value === null ? missing() : json(value);
    }
    if (operation === "tree") {
      const value = await fixture.git.readTree(name, hash);
      return value === null ? missing() : json(value);
    }
    if (operation === "blob") {
      const value = await fixture.git.readBlob(name, hash);
      if (value === null) return missing();
      response.end(value);
      return;
    }
    return missing();
  };
  const pending = [];
  const handle = async (request, response) => {
    try {
      await respond(request, response);
      return { kind: "completed" };
    } catch (cause) {
      response.statusCode = 500;
      response.end(cause instanceof Error ? cause.message : String(cause));
      return { kind: "failed", cause };
    }
  };
  const server = createServer((request, response) => {
    pending.push(handle(request, response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    close: async () => {
      try {
        server.closeAllConnections();
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        const outcomes = await Promise.all(pending);
        const failures = outcomes
          .filter((outcome) => outcome.kind === "failed")
          .map((outcome) => outcome.cause);
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "Workflow Git fixture requests failed",
          );
      } finally {
        fixture.close();
      }
    },
  };
}
