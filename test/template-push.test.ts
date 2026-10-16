import { execFile, spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { repositoryEnvironment } from "../src/build/git-environment.js";
import { pushTemplateSource } from "../src/source/template-push.js";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const appId = "app_shedproof";
const sourceRevision = `git:${"a".repeat(40)}`;
const credential = "Bearer template-push-disposable-sentinel";

let root: string;
let bare: string;
let server: Server;
let remote: string;
/** Every request's Authorization header, as the remote received it. */
let presented: (string | undefined)[];
/** Runs once, just before the next receive-pack exchange reaches Git. */
let beforeReceive: (() => Promise<void>) | undefined;

const git = async (...args: string[]) =>
  (
    await execFileAsync("git", [`--git-dir=${bare}`, ...args], {
      env: repositoryEnvironment(),
      encoding: "utf8",
    })
  ).stdout.trim();

/** Git's own smart-HTTP CGI behind a loopback server, keeping every received
 * pack as a pack so the test can read exactly what each push sent. */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oyster-template-push-test-"));
  bare = join(root, "template.git");
  await execFileAsync("git", [
    "init",
    "--quiet",
    "--bare",
    "--initial-branch=main",
    bare,
  ]);
  await git("config", "http.receivepack", "true");
  await git("config", "receive.unpackLimit", "0");
  presented = [];
  beforeReceive = undefined;
  server = createServer((request, response) => {
    void serveGit(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  remote = `http://127.0.0.1:${String(port)}/template.git`;
});

async function serveGit(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  presented.push(request.headers.authorization);
  const url = new URL(request.url ?? "/", "http://template.test");
  if (url.pathname.endsWith("/git-receive-pack") && beforeReceive) {
    const run = beforeReceive;
    beforeReceive = undefined;
    await run();
  }
  const environment: NodeJS.ProcessEnv = {
    ...repositoryEnvironment(),
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_PROJECT_ROOT: root,
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: request.method ?? "GET",
    CONTENT_TYPE: request.headers["content-type"] ?? "",
    REMOTE_USER: "template-push-test",
  };
  const protocol = request.headers["git-protocol"];
  if (protocol !== undefined) {
    environment.GIT_PROTOCOL = String(protocol);
    environment.HTTP_GIT_PROTOCOL = String(protocol);
  }
  const cgi = spawn("git", ["http-backend"], {
    env: environment,
    stdio: ["pipe", "pipe", "inherit"],
  });
  request.pipe(cgi.stdin);
  const chunks: Uint8Array[] = [];
  cgi.stdout.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  await new Promise<void>((resolve) => {
    cgi.once("close", () => {
      resolve();
    });
  });
  const output = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // CGI headers end at the first blank line (CRLF CRLF).
  let boundary = 0;
  while (
    boundary + 3 < output.length &&
    !(
      output[boundary] === 13 &&
      output[boundary + 1] === 10 &&
      output[boundary + 2] === 13 &&
      output[boundary + 3] === 10
    )
  )
    boundary += 1;
  let status = 200;
  for (const line of new TextDecoder()
    .decode(output.subarray(0, boundary))
    .split("\r\n")) {
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
    else response.setHeader(name, value);
  }
  response.statusCode = status;
  response.end(output.subarray(boundary + 4));
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(root, { recursive: true, force: true });
});

const files = (entries: Readonly<Record<string, string>>) =>
  Object.entries(entries).map(([path, text]) => ({
    path,
    contents: encoder.encode(text),
  }));

const push = (tree: ReturnType<typeof files>) =>
  pushTemplateSource({
    appId,
    sourceRevision,
    files: tree,
    remote,
    headers: { Authorization: credential },
  });

it("seeds a parentless commit with the exact bytes, then answers an exact retry without pushing", async () => {
  // Similar blobs that an ordinary push would delta-compress against each other.
  const similar = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `src/copy-${String(index)}.txt`,
      `${"repeated source line\n".repeat(200)}${String(index)}\n`,
    ]),
  );
  const tree = files({
    "index.js": 'export const app = "template";\r\n',
    ".gitattributes": "* text=auto eol=lf\n",
    ...similar,
  });
  const first = await push(tree);
  const head = await git("rev-parse", "refs/heads/main");
  expect(first).toEqual({ seedRevision: `git:${head}`, pushed: true });
  expect(await git("rev-list", "--count", "main")).toBe("1");
  expect(
    await git("log", "-1", "--format=%an <%ae> %at|%cn <%ce> %ct|%s", "main"),
  ).toBe(
    `Botanical App Source <app-source@botanical.invalid> 0|Botanical App Source <app-source@botanical.invalid> 0|Seed ${appId} from ${sourceRevision}`,
  );
  // No attributes or filters: CRLF bytes survive, every file is 100644.
  expect(await git("cat-file", "-s", "main:index.js")).toBe(
    String('export const app = "template";\r\n'.length),
  );
  expect(
    new Set(
      (await git("ls-tree", "-r", "--format=%(objectmode)", "main")).split(
        "\n",
      ),
    ),
  ).toEqual(new Set(["100644"]));
  // The pushed pack holds whole objects only: Artifacts' native fork drops deltas.
  const packs = (await readdir(join(bare, "objects", "pack"))).filter((name) =>
    name.endsWith(".idx"),
  );
  expect(packs).toHaveLength(1);
  const stat = await git(
    "verify-pack",
    "--stat-only",
    join(bare, "objects", "pack", packs[0] ?? ""),
  );
  expect(stat).toContain("non delta: 25 objects");
  expect(stat).not.toContain("chain length");
  // The credential reached every request, from Git's config environment only.
  expect(presented.length).toBeGreaterThan(0);
  expect(presented.every((value) => value === credential)).toBe(true);

  expect(await push(tree)).toEqual({
    seedRevision: `git:${head}`,
    pushed: false,
  });
  expect(await git("rev-parse", "refs/heads/main")).toBe(head);
});

it("publishes a changed tree as a fast-forward of the current head, without deltas", async () => {
  const first = await push(
    files({ "index.js": "one", "old.js": "gone later" }),
  );
  const second = await push(
    files({ "index.js": "two", "nested/deep/file.txt": "deep" }),
  );
  const head = await git("rev-parse", "refs/heads/main");
  expect(second).toEqual({ seedRevision: `git:${head}`, pushed: true });
  expect(`git:${await git("rev-parse", "main^")}`).toBe(first.seedRevision);
  expect(await git("show", "main:index.js")).toBe("two");
  expect(await git("show", "main^:old.js")).toBe("gone later");
  expect(await git("ls-tree", "-r", "--name-only", "main")).toBe(
    "index.js\nnested/deep/file.txt",
  );
  for (const pack of (await readdir(join(bare, "objects", "pack"))).filter(
    (name) => name.endsWith(".idx"),
  ))
    expect(
      await git(
        "verify-pack",
        "--stat-only",
        join(bare, "objects", "pack", pack),
      ),
    ).not.toContain("chain length");
});

it("writes the same tree Git itself records for the files", async () => {
  const tree = files({
    "b.txt": "b",
    "a/z.txt": "z",
    "a/b/c.txt": "c",
    "a-b.txt": "dash",
  });
  const pushed = await push(tree);
  const work = join(root, "work");
  await execFileAsync("git", ["init", "--quiet", work]);
  for (const file of tree) {
    const path = join(work, file.path);
    await execFileAsync("mkdir", ["-p", join(path, "..")]);
    await execFileAsync("sh", [
      "-c",
      'printf %s "$1" > "$2"',
      "sh",
      new TextDecoder().decode(file.contents),
      path,
    ]);
  }
  await execFileAsync("git", ["-C", work, "add", "-A"], {
    env: repositoryEnvironment(),
  });
  const expected = (
    await execFileAsync("git", ["-C", work, "write-tree"], {
      env: repositoryEnvironment(),
    })
  ).stdout.trim();
  expect(await git("rev-parse", `${pushed.seedRevision.slice(4)}^{tree}`)).toBe(
    expected,
  );
});

it("refuses a publication whose head moved since it fetched, without forcing", async () => {
  await push(files({ "index.js": "one" }));
  let racer = "";
  beforeReceive = async () => {
    const tree = await git("rev-parse", "main^{tree}");
    racer = (
      await execFileAsync(
        "git",
        [`--git-dir=${bare}`, "commit-tree", tree, "-p", "main", "-m", "racer"],
        {
          env: {
            ...repositoryEnvironment(),
            GIT_AUTHOR_NAME: "r",
            GIT_AUTHOR_EMAIL: "r@r",
            GIT_COMMITTER_NAME: "r",
            GIT_COMMITTER_EMAIL: "r@r",
          },
          encoding: "utf8",
        },
      )
    ).stdout.trim();
    await git("update-ref", "refs/heads/main", racer);
  };
  await expect(push(files({ "index.js": "two" }))).rejects.toThrow(
    /push failed/u,
  );
  expect(await git("rev-parse", "refs/heads/main")).toBe(racer);
});

it("refuses one path as both a file and a directory, or an escaping path, and pushes nothing", async () => {
  await expect(push(files({ a: "file", "a/b": "nested" }))).rejects.toThrow(
    /both a file and a directory/u,
  );
  for (const path of ["../escape", "a//b", ".git/config", "/abs"])
    await expect(push(files({ [path]: "x" }))).rejects.toThrow(/invalid/u);
  await expect(
    git("rev-parse", "--verify", "--quiet", "refs/heads/main"),
  ).rejects.toThrow();
});

it("refuses a remote carrying credentials", async () => {
  await expect(
    pushTemplateSource({
      appId,
      sourceRevision,
      files: files({ "index.js": "one" }),
      remote: remote.replace("http://", "http://user:secret@"),
      headers: {},
    }),
  ).rejects.toThrow(/credentials/u);
});
