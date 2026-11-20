import { recoveryStyle } from "./recovery-style.js";
import { html, raw } from "hono/html";
import type { AppTestCopy } from "./app-test-copies.js";
import { appSandbox } from "./app-sandbox.js";
import type { OysterAppConfig } from "./page-config.js";
import type { AppDeclaration } from "@fungi.computer/puffball/app";

/** Ordinary App mounting, but only the sibling backend/method doors are supplied. */
export async function appTestCopyPage(
  installationId: string,
  copy: AppTestCopy,
  declaration: AppDeclaration | null,
  pageModule: string,
): Promise<Response> {
  const base = `/recovery/${encodeURIComponent(installationId)}/test-copy/${encodeURIComponent(copy.copyId)}`;
  const config: OysterAppConfig = {
    workbench: false,
    shellModuleUrl: null,
    storage: false,
    appsOpen: false,
    computerId: null,
    authorityVersion: copy.selection.authorityVersion,
    commands: declaration?.commands ?? [],
    icon: declaration?.icon ?? null,
    roles: declaration?.roles ?? [],
    capabilities: [],
    installationId,
    appId: copy.selection.appId,
    releaseId: copy.selection.releaseId,
    uiUrl: `/ui/${installationId}/${copy.selection.releaseId}/`,
    backendUrl: `${base}/backend`,
    methodsUrl: `${base}/methods/`,
  };
  return new Response(
    await html`<!doctype html>
      <html lang="en">
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>Test copy · ${installationId}</title>
        ${recoveryStyle}
        <style>
          html,
          body {
            margin: 0;
            height: 100%;
          }
          body {
            display: flex;
            flex-direction: column;
          }
          iframe {
            border: 0;
            width: 100%;
            flex: 1;
            min-height: 0;
          }
        </style>
        <header class="bar">
          <strong>Disposable test copy: ${installationId}</strong>
          <p class="muted">
            Changes stay in this copy, not the live App. Live capabilities and
            network access are unavailable. Expires at
            ${new Date(copy.expiresAt).toISOString()}.
          </p>
          <form method="post" action="${base}/discard">
            <input
              type="hidden"
              name="authorityVersion"
              value="${copy.selection.authorityVersion}"
            />
            <input
              type="hidden"
              name="storeGeneration"
              value="${copy.storeGeneration}"
            />
            <input type="hidden" name="copyId" value="${copy.copyId}" />
            <button type="submit">Discard test copy</button>
          </form>
          <a href="/recovery">App recovery</a>
        </header>
        <!-- No src: the page module navigates the frame once it listens, so a
             first document cannot claim the connection and then be replaced. -->
        <iframe
          id="oyster-app"
          sandbox="${appSandbox}"
          title="${installationId} test copy"
        ></iframe>
        <script type="application/json" id="oyster-config">
          ${raw(JSON.stringify(config).replaceAll("<", "\\u003c"))}
        </script>
        <script type="module" src="${pageModule}"></script>
      </html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; worker-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      },
    },
  );
}
