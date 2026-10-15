import { memfs } from "memfs";
import { dirname, join } from "node:path";
import * as git from "isomorphic-git";
import * as Schema from "effect/Schema";
import type { Artifacts } from "@fungi.computer/burrow";
import { parseAppId, parseSourceRevision } from "@fungi.computer/puffball";
import {
  appIdSchema,
  sha256DigestSchema,
  sourceRevisionSchema,
} from "@fungi.computer/puffball/effect";
import {
  capturedPinnedRecipeSchema,
  digestPinnedRecipe,
} from "../build-contract.js";
import { templateRepositoryForApp } from "./template-repository.js";
import type { PublisherTemplateSeedReceipts } from "./seed-receipt.js";

function logEvent(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "app-publisher",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
  );
}

class TemplateRequestTooLarge extends Error {}

/** A bounded operator source upload; decoding happens only at the Publisher boundary. */
export const TEMPLATE_WRITE_MAX_REQUEST_BYTES = 24 * 1024 * 1024;

const templatePathSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (path) =>
        path.length > 0 &&
        path.length <= 4096 &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        path
          .split("/")
          .every(
            (part) =>
              part !== "" &&
              part !== "." &&
              part !== ".." &&
              part.toLowerCase() !== ".git",
          ),
    ),
  ),
);

export const templateWriteInputSchema = Schema.Struct({
  appId: appIdSchema,
  sourceRevision: sourceRevisionSchema,
  sourceTreeDigest: sha256DigestSchema,
  recipe: capturedPinnedRecipeSchema,
  files: Schema.Array(
    Schema.Struct({
      path: templatePathSchema,
      contents: Schema.Uint8ArrayFromBase64,
    }),
  ).pipe(
    Schema.check(
      Schema.makeFilter((files) => files.length > 0 && files.length <= 10_000),
    ),
  ),
});
export type TemplateWriteInput = Schema.Schema.Type<
  typeof templateWriteInputSchema
>;

/** The Publisher's own `exchangeGit` admission root (`source-git.ts`) stays the
 * sole caller of that physical transport; this port only ever sees a Request
 * in, a Response out, already bound to the one template repository. */
export type TemplateSourceTransport = Readonly<{
  ensureRepository: Artifacts["ensureRepository"];
  exchangeTemplateGit(repository: string, request: Request): Promise<Response>;
}>;

/** Isomorphic Git owns the protocol; the existing Artifacts owner owns every
 * credential and revokes it when the response stream closes. */
function templateHttp(
  transport: TemplateSourceTransport,
  repository: string,
  signal: AbortSignal,
): git.HttpClient & AsyncDisposable {
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const close = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    if (!readers.delete(reader)) return;
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  };
  return {
    async [Symbol.asyncDispose]() {
      const results = await Promise.allSettled([...readers].map(close));
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Template Git response cleanup failed");
    },
    async request(input) {
      signal.throwIfAborted();
      const chunks = input.body;
      const iterator =
        chunks === undefined
          ? undefined
          : (async function* () {
              yield* chunks;
            })();
      const body =
        iterator === undefined
          ? null
          : new ReadableStream<Uint8Array>({
              async pull(controller) {
                const item = await iterator.next();
                if (item.done) controller.close();
                else controller.enqueue(item.value);
              },
              async cancel() {
                await iterator.return(undefined);
              },
            });
      const init: RequestInit = {
        method: input.method ?? "GET",
        headers: new Headers(input.headers),
        body,
        signal,
      };
      if (body !== null) Object.assign(init, { duplex: "half" });
      const response = await transport.exchangeTemplateGit(
        repository,
        new Request(input.url, init),
      );
      // Own the reader before handing the iterable to Git, including when the
      // client never starts iteration or abandons it without calling return().
      const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
        response.body?.getReader();
      if (reader !== undefined) readers.add(reader);
      async function* responseChunks() {
        if (reader === undefined) return;
        try {
          for (;;) {
            signal.throwIfAborted();
            const item = await reader.read();
            if (item.done) return;
            yield item.value;
          }
        } finally {
          await close(reader);
        }
      }
      return {
        url: input.url,
        method: input.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: responseChunks(),
      };
    },
  };
}

/** Each request owns an in-memory Git working tree. Uploaded source never
 * executes here and callers supply no provider token; the maintained Git client
 * writes and compares trees. */
async function writeTemplate(
  transport: TemplateSourceTransport,
  input: TemplateWriteInput,
  repository: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { fs } = memfs();
  const dir = "/template";
  await git.init({ fs, dir, defaultBranch: "main" });
  const paths = new Set<string>();
  for (const file of input.files) {
    signal.throwIfAborted();
    if (paths.has(file.path)) throw new Error("Duplicate template source path");
    paths.add(file.path);
    const target = join(dir, file.path);
    await fs.promises.mkdir(dirname(target), { recursive: true });
    await fs.promises.writeFile(target, file.contents);
  }
  await git.add({ fs, dir, filepath: [...paths], force: true });
  const oid = await git.commit({
    fs,
    dir,
    author: {
      name: "Botanical App Source",
      email: "app-source@botanical.invalid",
      timestamp: 0,
      timezoneOffset: 0,
    },
    message: `Seed ${input.appId} from ${input.sourceRevision}`,
  });
  await using http = templateHttp(transport, repository, signal);
  const url = `https://git.team.internal/${repository}.git`;
  await git.addRemote({ fs, dir, remote: "origin", url });
  const refs = await git.listServerRefs({
    http,
    url,
    prefix: "refs/heads/main",
  });
  const main = refs.find((ref) => ref.ref === "refs/heads/main");
  if (main !== undefined) {
    await git.fetch({
      fs,
      http,
      dir,
      url,
      ref: "main",
      singleBranch: true,
      depth: 1,
      tags: false,
    });
    const expected = await git.readCommit({ fs, dir, oid });
    const actual = await git.readCommit({ fs, dir, oid: main.oid });
    if (expected.commit.tree !== actual.commit.tree) return null;
  }
  if (main === undefined) {
    // isomorphic-git's pack writer sends whole objects, preserving Artifacts
    // native forks' requirement that seed packs contain no delta objects.
    const pushed = await git.push({
      fs,
      http,
      dir,
      url,
      ref: "main",
      remoteRef: "main",
      signal,
    });
    if (!pushed.ok) throw new Error("Template Git push refused");
  }
  // A successful push or matching fetched tree is not sufficient: retain the
  // former Publisher receipt check that main still names this exact commit.
  const expectedHead = main?.oid ?? oid;
  const confirmed = await git.listServerRefs({
    http,
    url,
    prefix: "refs/heads/main",
  });
  return confirmed.find((ref) => ref.ref === "refs/heads/main")?.oid ===
    expectedHead
    ? expectedHead
    : null;
}

/** The only operator template-write result contains provenance, never custody. */
export async function seedPublisherTemplate(
  receipts: PublisherTemplateSeedReceipts,
  transport: TemplateSourceTransport,
  rawAppId: string,
  request: Request,
) {
  try {
    const appId = parseAppId(rawAppId);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > TEMPLATE_WRITE_MAX_REQUEST_BYTES
    )
      return { kind: "too-large" } as const;
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(240_000),
    ]);
    let bytes = 0;
    const bounded = request.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > TEMPLATE_WRITE_MAX_REQUEST_BYTES)
            throw new TemplateRequestTooLarge();
          controller.enqueue(chunk);
        },
      }),
      { signal },
    );
    let input: TemplateWriteInput;
    try {
      const body: unknown = await new Response(bounded).json();
      input = Schema.decodeUnknownSync(templateWriteInputSchema, {
        onExcessProperty: "error",
      })(body);
    } catch (cause) {
      logEvent("operator.template.decode", cause);
      return {
        kind:
          cause instanceof TemplateRequestTooLarge ? "too-large" : "invalid",
      } as const;
    }
    if (input.appId !== appId) return { kind: "conflict" } as const;
    const repository = templateRepositoryForApp(appId);
    await transport.ensureRepository(repository);
    const oid = await writeTemplate(transport, input, repository, signal);
    if (oid === null) return { kind: "conflict" } as const;
    const seedRevision = parseSourceRevision(`git:${oid}`);
    const receipt = {
      appId,
      sourceRevision: input.sourceRevision,
      sourceTreeDigest: input.sourceTreeDigest,
      seedRevision,
      recipe: input.recipe,
      buildRecipeDigest: digestPinnedRecipe(input.recipe),
    };
    const existing = await receipts.read(appId, seedRevision);
    if (
      existing !== null &&
      (existing.sourceRevision !== receipt.sourceRevision ||
        existing.sourceTreeDigest !== receipt.sourceTreeDigest ||
        existing.buildRecipeDigest !== receipt.buildRecipeDigest)
    )
      return { kind: "conflict" } as const;
    // Recording still uses the write-once, digest-checked Publisher receipt owner.
    await receipts.record(receipt);
    return {
      kind: existing === null ? "recorded" : "existing",
      receipt: {
        appId,
        repository,
        sourceRevision: receipt.sourceRevision,
        sourceTreeDigest: receipt.sourceTreeDigest,
        seedRevision,
        buildRecipeDigest: receipt.buildRecipeDigest,
      },
    } as const;
  } catch (cause) {
    logEvent("operator.template.write", cause);
    return { kind: "unavailable" } as const;
  }
}
