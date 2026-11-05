/** Build-time host illustrations and layout; acquired only on page requests. */
export declare const hostPageAssets: Readonly<
  Record<
    string,
    Readonly<{
      path: string;
      contentType: string;
      source: string;
      encoding: "utf8" | "base64";
    }>
  >
>;
