// A one-time sign-in link for `oyster try`. The owner key never goes in a URL:
// the link opens a page served by this process that posts the key to the local
// Oyster's own /login form, then the server forgets the key. The listener stays
// up for the whole try session, so a reused link lands on /login with a note.
import { awaitCleanup } from "../build/process-group.js";
import { createHash, randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { createServer } from "node:http";
import * as z from "zod";
import { hostPage } from "../host-page.js";
import { loadPageAssets } from "../page-assets.js";

const addressSchema = z.object({ port: z.number() });

export type SignInLink = Readonly<{ url: string; close: () => Promise<void> }>;

/** Serve one single-use page that signs the owner in to `oysterUrl`, until closed. */
export async function startSignInLink(
  input: Readonly<{ oysterUrl: string; key: string; signal?: AbortSignal }>,
): Promise<SignInLink> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const nonce = Array.from(randomBytes(18), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let used = false;
  const sources = await loadPageAssets();
  const stylesheets = Object.entries({
    "styles.css": sources.shellStyles,
    "login-fonts.css": sources.loginFontStyles,
  }).map(
    ([name, source]) =>
      `/_oyster/assets/${createHash("sha256")
        .update(source)
        .digest("hex")}/${name}`,
  );
  const pageOptions = { oysterUrl: input.oysterUrl, stylesheets };
  let page = await (
    await hostPage({
      ...pageOptions,
      state: "signing-in",
      signIn: {
        action: new URL("/login", input.oysterUrl).href,
        key: input.key,
      },
    })
  ).text();
  const notFound = await (
    await hostPage({ ...pageOptions, state: "not-found", status: 404 })
  ).text();
  signal.throwIfAborted();
  const server = createServer((request, response) => {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method !== "GET" || request.url !== `/${nonce}`) {
      response.writeHead(404, headers).end(notFound);
      return;
    }
    if (used) {
      response
        .writeHead(302, {
          ...headers,
          Location: new URL("/login?link=used", input.oysterUrl).href,
        })
        .end();
      return;
    }
    used = true;
    response.writeHead(200, headers).end(page);
    page = "";
  });
  let closing: Promise<PromiseSettledResult<void>[]> | undefined;
  let abortListener: ReturnType<typeof addAbortListener> | undefined;
  const beginClose = () =>
    (closing ??= Promise.allSettled([
      (async () => {
        page = "";
        abortListener?.[Symbol.dispose]();
        await new Promise<void>((resolve, reject) => {
          server.close((cause) => {
            if (
              cause &&
              !("code" in cause && cause.code === "ERR_SERVER_NOT_RUNNING")
            )
              reject(cause);
            else resolve();
          });
          server.closeAllConnections();
        });
      })(),
    ]));
  const close = () => awaitCleanup(beginClose());
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      // listen is called synchronously before yielding ownership; cancellation
      // joins the acquired listener even when it wins before the listen event.
      server.listen(0, "127.0.0.1", () => {
        server.off("error", fail);
        done();
      });
    });
    signal.throwIfAborted();
    abortListener = addAbortListener(signal, () => {
      void beginClose();
    });
    const { port } = addressSchema.parse(server.address());
    return { url: `http://127.0.0.1:${String(port)}/${nonce}`, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}
