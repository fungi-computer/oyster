/** Owns the page's App connections and services until disconnect or pagehide. */
export function createPageLifetime(page: EventTarget) {
  const controller = new AbortController();
  const dispose = () => {
    controller.abort();
    page.removeEventListener("pagehide", dispose);
  };
  page.addEventListener("pagehide", dispose, { once: true });
  return {
    signal: controller.signal,
    own: (release: () => void) => {
      if (controller.signal.aborted) release();
      else controller.signal.addEventListener("abort", release, { once: true });
    },
    dispose,
  };
}
