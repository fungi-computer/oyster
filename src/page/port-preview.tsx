import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@fungi.computer/caps/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fungi.computer/caps/components/dialog";
import { Toaster, toast } from "@fungi.computer/caps/components/toaster";
import {
  portPreviewEntrySchema,
  portPreviewRefusalMessage,
} from "../port-preview-entry.js";
import { computerTargetUrl } from "../computer-target.js";
import { readPortPreviewDetails } from "../port-preview-details.js";
import { bootstrapIsolatedPageTheme } from "./isolated-page-theme.js";

const root = document.querySelector<HTMLElement>("[data-port-preview-entry]");
if (root === null) throw new Error("Port preview confirmation is missing");
const entry = portPreviewEntrySchema.parse({
  action: root.dataset.action,
  computerId: root.dataset.computerId,
  computerName: root.dataset.computerName,
  port: Number(root.dataset.port),
  refusal: root.dataset.refusal,
});
const toasterId = "port-preview";

function PortPreviewDialog() {
  const cancel = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  // An App's cross-site popup GET carries no Strict owner cookie. This read
  // originates inside Oyster, so the same route can disclose its name to its
  // owner. The dialog shows at once; the name arrives, or its failure is named.
  const [name, setName] = useState<{
    settled: boolean;
    value: string | undefined;
  }>({ settled: entry.computerName !== undefined, value: entry.computerName });
  useEffect(() => {
    if (entry.computerName !== undefined) return;
    let current = true;
    void readPortPreviewDetails(
      computerTargetUrl(entry.action, entry.computerId),
    ).then((details) => {
      if (!current) return;
      if (details.kind === "failed")
        toast.error(details.message, { toasterId });
      setName({
        settled: true,
        value: details.kind === "loaded" ? details.computerName : undefined,
      });
    });
    return () => {
      current = false;
    };
  }, []);
  // The delay starts when the name, or its failure, is on screen, so the
  // owner can read the Computer before Open preview enables.
  useEffect(() => {
    if (!name.settled) return;
    const timer = window.setTimeout(() => {
      setReady(true);
    }, 600);
    return () => {
      window.clearTimeout(timer);
    };
  }, [name.settled]);
  useEffect(() => {
    if (entry.refusal !== undefined)
      toast.error(portPreviewRefusalMessage(entry.refusal), { toasterId });
  }, []);
  return (
    <>
      <Dialog
        defaultOpen
        onOpenChange={(open) => {
          if (!open) window.location.assign("/");
        }}
      >
        <DialogContent initialFocus={cancel}>
          <form
            method="post"
            action={entry.action}
            onSubmit={(event) => {
              if (!ready || !name.settled) event.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>Open this preview?</DialogTitle>
              <DialogDescription>
                An App asked to open a private preview using your Oyster
                sign-in. Only continue if you expected it.
              </DialogDescription>
            </DialogHeader>
            <dl className="mt-md text-sm">
              <div
                className="flex h-8 items-center justify-between gap-sm"
                data-preview-fact
              >
                <dt>Computer</dt>
                <dd className="min-w-0 truncate">
                  {!name.settled && (
                    <span
                      className="text-muted-foreground"
                      data-preview-name-loading
                    >
                      Loading name…{" "}
                    </span>
                  )}
                  {name.value && <span>{name.value} </span>}
                  <span className="font-mono">{entry.computerId}</span>
                </dd>
              </div>
              <div
                className="flex h-8 items-center justify-between gap-sm"
                data-preview-fact
              >
                <dt>Port</dt>
                <dd className="font-mono">{entry.port}</dd>
              </div>
            </dl>
            <DialogFooter className="mt-lg">
              <DialogClose
                ref={cancel}
                render={<Button variant="outline" size="sm" />}
              >
                Cancel
              </DialogClose>
              <Button
                type="submit"
                size="sm"
                disabled={!ready || !name.settled}
              >
                Open preview
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Toaster id={toasterId} />
    </>
  );
}

// Caps enables the native form after the confirmation delay.
// No script submits the form or requests preview credentials.
bootstrapIsolatedPageTheme();
document.body.replaceChildren(root);
createRoot(root).render(<PortPreviewDialog />);
