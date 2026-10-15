/**
 * Files for Apps on a standalone Oyster: one file-source contract, routes the App
 * page calls. Apps reach files through Agar's
 * `computer.list`, `computer.readFile` and `computer.writeFile` contracts, so
 * an App written for a Computer (an editor, a workflow step) works against
 * the Oyster's workspace unchanged. Other sources (a git repository) implement
 * the same `FileSource`.
 */
import { Hono } from "hono";
import * as Schema from "effect/Schema";
import {
  computerList,
  computerReadFile,
  computerWriteFile,
} from "@fungi.computer/agar/computer";
import type { CapabilityEnv, OysterCapability } from "./host.js";

/** One entry of a directory listing, in Agar's `computer.list` contract. */
export type FileEntry = Readonly<{
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: number;
}>;

/** A page of a directory, in Agar's `computer.list` contract. */
export type FileListing = Readonly<{
  path: string;
  entries: readonly FileEntry[];
  nextOffset: number | null;
}>;

/** What a conditional replace did, in Agar's `computer.writeFile` contract. */
export type FileReplaceOutcome =
  | Readonly<{ kind: "replaced"; path: string; bytes: number }>
  | Readonly<{ kind: "conflict" }>;

/**
 * Where an Oyster's files live. Paths are absolute (`/notes/a.md`) and
 * already normalized by the routes; a source never sees `..`.
 */
export type FileSource = Readonly<{
  /** One page of a directory's entries, or `null` when it does not exist. */
  list(
    path: string,
    limit: number,
    offset: number,
  ): Promise<FileListing | null>;
  /** A file's bytes, or `null` when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Create or replace a file. */
  write(path: string, content: Uint8Array): Promise<void>;
  /** Create a directory. */
  mkdir(path: string): Promise<void>;
  /** Write `content` only if the file still holds `expectedContent`. */
  replace(
    path: string,
    expectedContent: string,
    content: string,
  ): Promise<FileReplaceOutcome>;
}>;

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LIST = 1000;

/** Normalize an absolute path; `null` when it is not one or escapes the root. */
export function normalizeFilePath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.length > 4096 || raw.includes("\0"))
    return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const replaceSchema = Schema.Struct({
  path: Schema.String,
  expectedContent: Schema.String,
  content: Schema.String,
});
const mkdirSchema = Schema.Struct({ path: Schema.String });

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** File capabilities sharing the existing `/files/` wire and one file source. */
export function fileCapabilities(
  source: FileSource,
): readonly OysterCapability[] {
  const routes = createFileRoutes(source);
  const shared = { base: "/files/", routes };
  return [
    {
      ...shared,
      id: "computer.list",
      permission: "computer.list",
      version: computerList.version,
      methods: { list: { kind: "json", method: "GET", path: "list" } },
    },
    {
      ...shared,
      id: "computer.readFile",
      permission: "computer.readFile",
      version: computerReadFile.version,
      methods: { open: { kind: "read", method: "GET", path: "content" } },
    },
    {
      ...shared,
      id: "computer.writeFile",
      permission: "computer.writeFile",
      version: computerWriteFile.version,
      methods: {
        open: { kind: "write", method: "PUT", path: "content" },
        mkdir: { kind: "json", method: "POST", path: "mkdir" },
        replace: { kind: "json", method: "POST", path: "replace" },
      },
    },
  ];
}

function createFileRoutes(source: FileSource): Hono<CapabilityEnv> {
  const routes = new Hono<CapabilityEnv>();
  const pathOf = (raw: string | undefined) => normalizeFilePath(raw ?? "");
  routes.get("/list", async (context) => {
    const path = pathOf(context.req.query("path"));
    if (path === null) return refusal(400, "Invalid path");
    const limit = Math.min(
      MAX_LIST,
      Math.max(1, Number(context.req.query("limit") ?? "256") || 256),
    );
    const offset = Math.max(0, Number(context.req.query("offset") ?? "0") || 0);
    const listing = await source.list(path, limit, offset);
    return listing === null
      ? refusal(404, "No such directory")
      : Response.json(listing);
  });
  routes.get("/content", async (context) => {
    const path = pathOf(context.req.query("path"));
    if (path === null) return refusal(400, "Invalid path");
    const bytes = await source.read(path);
    return bytes === null
      ? refusal(404, "No such file")
      : new Response(bytes, {
          headers: { "Content-Type": "application/octet-stream" },
        });
  });
  routes.put("/content", async (context) => {
    const path = pathOf(context.req.query("path"));
    if (path === null || path === "/") return refusal(400, "Invalid path");
    const length = Number(context.req.header("content-length") ?? "0");
    if (length > MAX_FILE_BYTES) return refusal(413, "File too large");
    const bytes = new Uint8Array(await context.req.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) return refusal(413, "File too large");
    await source.write(path, bytes);
    return new Response(null, { status: 204 });
  });
  routes.post("/mkdir", async (context) => {
    const body = Schema.decodeUnknownOption(mkdirSchema)(
      await context.req.json(),
    );
    const path =
      body._tag === "Some" ? normalizeFilePath(body.value.path) : null;
    if (path === null || path === "/") return refusal(400, "Invalid path");
    await source.mkdir(path);
    return new Response(null, { status: 204 });
  });
  routes.post("/replace", async (context) => {
    const body = Schema.decodeUnknownOption(replaceSchema)(
      await context.req.json(),
    );
    const path =
      body._tag === "Some" ? normalizeFilePath(body.value.path) : null;
    if (body._tag === "None" || path === null)
      return refusal(400, "Invalid request");
    return Response.json(
      await source.replace(
        path,
        body.value.expectedContent,
        body.value.content,
      ),
    );
  });
  return routes;
}
