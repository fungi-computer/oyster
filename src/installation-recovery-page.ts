import { html } from "hono/html";
import { recoveryStyle } from "./recovery-style.js";
import { z } from "zod";
import type { Installation } from "./apps/installation.js";
import {
  appTestCopySchema,
  type AppTestCopy,
  type AppTestCopyAuthority,
} from "./app-test-copies.js";
import {
  installationCommandIds,
  installationRequestIdSchema,
  installationRecoverySelectionSchema,
  type InstallationOperation,
  type InstallationRecovery,
} from "./installation-operations.js";

export const installationRecoveryFormSchema =
  installationRecoverySelectionSchema.extend({
    authorityVersion: z.coerce
      .number()
      .pipe(installationRecoverySelectionSchema.shape.authorityVersion),
    requestId: installationRequestIdSchema,
  });
/** Discard names a resource, not the creation request whose receipt may expire. */
export const appTestCopyDiscardFormSchema = installationRecoveryFormSchema
  .omit({ requestId: true })
  .extend({ copyId: appTestCopySchema.shape.copyId });

const fields = (authorityVersion: number, storeGeneration: string) => html`
  <input type="hidden" name="authorityVersion" value="${authorityVersion}" />
  <input type="hidden" name="storeGeneration" value="${storeGeneration}" />
`;

const rollbackMessage = (operation: InstallationOperation) => {
  const app = operation.installationId;
  switch (operation.state) {
    case "pending":
      return `Rolling back ${app}…`;
    case "succeeded":
      return `Rolled back ${app}`;
    case "refused":
      return `Rollback failed: ${operation.code.replaceAll("_", " ")}`;
    case "unconfirmed":
      return `Rollback not confirmed (${operation.outcome.replaceAll("_", " ")}). Check again.`;
  }
};

/** No selected App, editable Shell, JavaScript or asset loader is needed. */
export async function installationRecoveryPage(
  entries: readonly Readonly<{
    installation: Installation;
    recovery: InstallationRecovery | null;
    copy: AppTestCopy | null;
    copyAuthority: AppTestCopyAuthority | null;
  }>[],
  operation: InstallationOperation | null,
  /** The App whose rollback awaits an in-page confirmation. */
  confirming: string | null = null,
): Promise<Response> {
  return new Response(
    await html`<!doctype html>
      <html lang="en">
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>App recovery</title>
        ${recoveryStyle}
        <main>
          <h1>App recovery</h1>
          <p class="lede">
            Roll an App back to its previous version. Your App's data stays as
            it is; this doesn't undo anything the App already did.
          </p>
          ${
            operation === null
              ? ""
              : html`<div class="card" role="status">
                  <p><strong>${rollbackMessage(operation)}</strong></p>
                  <p><a href="">Check again</a></p>
                </div>`
          }
          ${entries.map(
            ({ installation, recovery, copy, copyAuthority }) => html`
              <section class="card">
                <h2>${installation.installationId}</h2>
                <p>
                  Running: current version
                  <small class="muted">${installation.release.releaseId}</small>
                </p>
                ${
                  recovery === null
                    ? html`<p class="muted">
                        No earlier version to roll back to yet.
                      </p>`
                    : html`
                        <p>
                          Can roll back to: previous version
                          <small class="muted"
                            >${recovery.release.releaseId}</small
                          >
                        </p>
                        <p>
                          Last check:
                          ${recovery.uiCheck.kind.replaceAll("_", " ")}
                          ${
                            recovery.uiCheck.kind === "not_checked"
                              ? html`<small class="muted"
                                  >${recovery.uiCheck.code}</small
                                >`
                              : ""
                          }
                        </p>
                        ${
                          confirming === installation.installationId
                            ? html`<form
                                method="post"
                                action="/recovery/${installation.installationId}/rollback"
                                role="alertdialog"
                                aria-label="Confirm rollback"
                              >
                                <p>
                                  <strong
                                    >Roll back ${installation.installationId} to
                                    the previous version?</strong
                                  >
                                </p>
                                ${fields(
                                  recovery.authorityVersion,
                                  recovery.storeGeneration,
                                )}
                                <input
                                  type="hidden"
                                  name="requestId"
                                  value="${installationCommandIds.request.generate()}"
                                />
                                <div class="row">
                                  <button type="submit" class="primary">
                                    Roll back
                                  </button>
                                  <a href="/recovery">Cancel</a>
                                </div>
                              </form>`
                            : html`<div class="row">
                                <a
                                  class="button primary"
                                  href="/recovery?confirm=${installation.installationId}"
                                  >Roll back</a
                                >
                              </div>`
                        }
                      `
                }
                ${
                  copyAuthority === null
                    ? html`<p class="muted">
                        Test copy not available for this App.
                      </p>`
                    : copy === null
                      ? html`<form
                          method="post"
                          action="/recovery/${installation.installationId}/test-copy"
                        >
                          ${fields(
                            copyAuthority.selection.authorityVersion,
                            copyAuthority.storeGeneration,
                          )}
                          <input
                            type="hidden"
                            name="requestId"
                            value="${installationCommandIds.request.generate()}"
                          />
                          <div class="row">
                            <button type="submit">Open test copy</button>
                          </div>
                        </form>`
                      : html`<p>
                            <a
                              href="/recovery/${installation.installationId}/test-copy/${copy.copyId}"
                              >Open test copy</a
                            >
                            <small class="muted"
                              >expires at
                              ${new Date(copy.expiresAt).toISOString()}</small
                            >
                          </p>
                          <form
                            method="post"
                            action="/recovery/${installation.installationId}/test-copy/${copy.copyId}/discard"
                          >
                            ${fields(
                              copy.selection.authorityVersion,
                              copy.storeGeneration,
                            )}
                            <input
                              type="hidden"
                              name="copyId"
                              value="${copy.copyId}"
                            />
                            <button type="submit">Discard test copy</button>
                          </form>`
                }
              </section>
            `,
          )}
        </main>
      </html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      },
    },
  );
}
