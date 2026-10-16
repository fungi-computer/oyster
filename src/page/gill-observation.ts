/** One desktop observation notifies the shell until it is closed. */
export function observeDesktopGill(
  onChanged: () => Promise<void>,
  openSource: () =>
    (Pick<EventTarget, "addEventListener"> & { close(): void }) | null,
  focus: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): () => void {
  let closed = false;
  const notify = () => {
    if (!closed)
      void onChanged().catch((cause: unknown) => {
        console.error("Desktop Gill observation failed", cause);
      });
  };
  let source: ReturnType<typeof openSource> = null;
  const close = () => {
    if (closed) return;
    closed = true;
    source?.close();
    focus.removeEventListener("focus", notify);
  };
  try {
    source = openSource();
    if (source !== null)
      for (const event of ["ready", "rows", "reset", "changed"])
        source.addEventListener(event, notify);
    else focus.addEventListener("focus", notify);
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
