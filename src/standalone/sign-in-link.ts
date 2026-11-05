// A one-time sign-in link for `oyster try`. The owner key never goes in a URL:
// the link opens a page served by this process that posts the key to the local
// Oyster's own /login form, then the server forgets the link.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as z from "zod";

const addressSchema = z.object({ port: z.number() });
const lifetimeMs = 10 * 60_000;

export type SignInLink = Readonly<{ url: string; close: () => void }>;

const escapeAttribute = (text: string) =>
  text.replace(
    /[&"<>]/gu,
    (character) => `&#${String(character.codePointAt(0))};`,
  );

/** Serve one single-use page that signs the owner in to `oysterUrl`. */
export async function startSignInLink(
  input: Readonly<{ oysterUrl: string; key: string }>,
): Promise<SignInLink> {
  const nonce = Array.from(randomBytes(18), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let used = false;
  const page =
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Signing in to Oyster</title>` +
    `<form method="post" action="${escapeAttribute(new URL("/login", input.oysterUrl).href)}">` +
    `<input type="hidden" name="key" value="${escapeAttribute(input.key)}"></form>` +
    `<p>Signing in to Oyster...</p><script>document.forms[0].submit()</script>`;
  const server = createServer((request, response) => {
    if (used || request.method !== "GET" || request.url !== `/${nonce}`) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end("Not found");
      return;
    }
    used = true;
    response
      .writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      .end(page);
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
