// Build-time facts about the website visitor programs. Never import this
// from a Worker: it is megabytes of source every isolate would carry.

/** The launcher's real esbuild graph, for consumer asset checks. */
export declare const embedLoaderMetafile: import("esbuild").Metafile;

/** The widget's real esbuild graph, for consumer browser-boundary checks. */
export declare const embedWidgetMetafile: import("esbuild").Metafile;
