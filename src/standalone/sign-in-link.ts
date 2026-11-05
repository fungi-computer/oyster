// A one-time sign-in link for `oyster try`. The owner key never goes in a URL:
// the link opens a page served by this process that posts the key to the local
// Oyster's own /login form, then the server forgets the link.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as z from "zod";
import { hostPage } from "../host-page.js";
import { loadPageAssets } from "../page-assets.js";

const addressSchema = z.object({ port: z.number() });
const lifetimeMs = 10 * 60_000;

export type SignInLink = Readonly<{ url: string; close: () => void }>;

/** Serve one single-use page that signs the owner in to `oysterUrl`. */
export async function startSignInLink(
  input: Readonly<{ oysterUrl: string; key: string }>,
): Promise<SignInLink> {
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
  const expired = await (
    await hostPage({ ...pageOptions, state: "link-expired", status: 404 })
  ).text();
  const notFound = await (
    await hostPage({ ...pageOptions, state: "not-found", status: 404 })
  ).text();
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
      response.writeHead(404, headers).end(expired);
      return;
    }
    used = true;
    response.writeHead(200, headers).end(page);
    page = "";
    setTimeout(() => {
      server.close();
    }, 1_000).unref();
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  setTimeout(() => {
    server.close();
  }, lifetimeMs).unref();
  const { port } = addressSchema.parse(server.address());
  return {
    url: `http://127.0.0.1:${String(port)}/${nonce}`,
    close: () => {
      server.close();
    },
  };
}
