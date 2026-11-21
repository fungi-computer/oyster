import { useEffect } from "react";
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
import { bootstrapIsolatedPageTheme } from "./isolated-page-theme.js";

const root = document.querySelector<HTMLElement>("[data-port-preview-entry]");
if (root === null) throw new Error("Port preview confirmation is missing");
const entry = portPreviewEntrySchema.parse({
  action: root.dataset.action,
  computerId: root.dataset.computerId,
  port: Number(root.dataset.port),
  refusal: root.dataset.refusal,
});
const toasterId = "port-preview";

function PortPreviewDialog() {
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
        <DialogContent>
          <form method="post" action={entry.action}>
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
                <dd className="min-w-0 truncate font-mono">
                  {entry.computerId}
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
              <DialogClose render={<Button variant="outline" size="sm" />}>
                Cancel
              </DialogClose>
              <Button type="submit" size="sm">
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

// The native form remains usable without JavaScript. Enhance it with Caps;
// no script submits the form or requests preview credentials.
bootstrapIsolatedPageTheme();
document.body.replaceChildren(root);
createRoot(root).render(<PortPreviewDialog />);
