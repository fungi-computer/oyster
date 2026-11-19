import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, showNotice } from "@fungi.computer/caps/components/toaster";
import type { appStorageErrorCodes } from "@fungi.computer/agar/storage";

const toasterId = "oyster-storage-notices";

const reasons = {
  invalid: "it asked to watch storage with a request the host could not read",
  undeclared_key: "it watches a storage key it never declared",
  scope_not_declared: "it watches storage in a scope it never declared",
  owner_required: "only the owner can watch its storage",
  too_large: "its storage change was too large to send",
  quota_exceeded: "this page is already watching the most storage keys it can",
  conflict: "its storage changed in a conflicting way",
  unavailable: "its storage is not available right now",
} satisfies Record<(typeof appStorageErrorCodes)[number], string>;

let mounted = false;

/** Tell the person, once per refusal, why a Desktop App will not update live. */
export function showStorageRefusal(
  installationId: string,
  code: (typeof appStorageErrorCodes)[number],
): void {
  if (!mounted) {
    mounted = true;
    const root = document.createElement("div");
    document.body.append(root);
    createRoot(root).render(createElement(Toaster, { id: toasterId }));
  }
  showNotice(
    {
      tone: "error",
      message: `${installationId} will not update live: ${reasons[code]}.`,
    },
    toasterId,
  );
}
