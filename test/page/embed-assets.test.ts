import { describe, expect, it } from "vitest";
import * as served from "@fungi.computer/oyster/embed/assets";
import {
  embedLoaderMetafile,
  embedWidgetMetafile,
} from "@fungi.computer/oyster/embed/metafiles";

const { embedLoaderScript, embedWidgetScript } = served;

// Consume the fresh package build (Turbo owns that prerequisite), not the
// host's copied asset files. Hub's browser proof exercises those same bytes.
describe("website visitor browser programs", () => {
  it("ships the launcher and iframe from Oyster's browser entries", () => {
    expect(embedLoaderScript).toContain("fungi-embed");
    expect(embedWidgetScript).toContain("fungi-embed");
    expect(Object.values(embedLoaderMetafile.outputs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryPoint: "src/page/embed-loader.tsx",
        }),
      ]),
    );
    expect(Object.values(embedWidgetMetafile.outputs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryPoint: "src/page/embed-widget.tsx",
        }),
      ]),
    );
  });

  // The standalone Worker bundles this module, and celld keeps that source in
  // every isolate heap its cells share. The esbuild graphs were 4.5 MB of it;
  // carrying them left a fresh self-hosted Oyster too little of celld's
  // default 128 MB heap to install the starter Apps.
  it("serves only the bytes a Worker answers with", () => {
    expect(Object.keys(served).sort()).toEqual([
      "embedLoaderScript",
      "embedStyles",
      "embedWidgetScript",
    ]);
  });

  it("keeps the iframe's browser graph free of Hono and the server SSE pump", () => {
    expect(
      Object.keys(embedWidgetMetafile.inputs).filter(
        (path) =>
          /(?:^|\/)hono\/dist\//u.test(path) ||
          /(?:^|\/)(?:client|server)-visitor-stream\.js$/u.test(path),
      ),
    ).toEqual([]);
  });
});
