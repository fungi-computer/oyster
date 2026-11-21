import type { HostPageOptions } from "./host-page.js";
import { loadLazily } from "./lazy-import.js";

// The page renderer brings React's server renderer, the Caps components and
// their animation library. Only a request that renders a page needs them, so
// Worker startup does not evaluate them; the first page loads them.
const renderer = "Oyster's host page renderer";

/** Render one host page, loading the renderer on first use. */
export async function renderHostPage(
  options: HostPageOptions,
): Promise<Response> {
  const render = await loadLazily(
    () => import("./host-page.js").then(({ hostPage }) => hostPage),
    renderer,
  );
  return render(options);
}

/** Serve one content-addressed host page asset, loading the renderer on first use. */
export async function serveHostPageAsset(path: string): Promise<Response> {
  const serve = await loadLazily(
    () => import("./host-page.js").then(({ hostPageAsset }) => hostPageAsset),
    renderer,
  );
  return serve(path);
}

export async function renderPreviewStyles(): Promise<string> {
  const render = await loadLazily(
    () => import("./host-page.js").then((module) => module.previewStyles),
    renderer,
  );
  return render();
}

export async function renderPreviewChrome(
  notice: import("./host-page.js").PreviewNotice,
): Promise<string> {
  const render = await loadLazily(
    () => import("./host-page.js").then((module) => module.previewChrome),
    renderer,
  );
  return render(notice);
}
