import { HTTPException } from "hono/http-exception";

/**
 * Project the generated module's fields without exposing its private module name.
 * The generated module remains the sole page-source contract.
 * @inline
 */
export type PageAssetSources = {
  [
    Key in keyof typeof import("#page-script")
  ]: (typeof import("#page-script"))[Key];
};

/**
 * Acquire page sources only when a host page or asset request needs them.
 */
export type PageAssetLoader = () => Promise<PageAssetSources>;

/** A failed acquisition refuses this request without exposing loader details. */
export class PageAssetsLoadError extends HTTPException {
  constructor(cause: unknown) {
    super(503, { message: "Host page assets unavailable", cause });
  }

  override getResponse(): Response {
    // Concurrent callers share the failure, not a one-use response body.
    return new Response(this.message, {
      status: this.status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}

/**
 * Missing page sources must fail the request, never produce an empty script.
 */
export const loadPageAssets: PageAssetLoader = async () => {
  try {
    return await import("#page-script");
  } catch (cause) {
    throw new PageAssetsLoadError(cause);
  }
};
