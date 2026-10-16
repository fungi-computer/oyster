import { StandaloneInstance as GitWrappedInstance } from "./workflows-root.fixture.js";
import { MediaOperationDO as DarkroomMediaOperationDO } from "@fungi.computer/darkroom/cloudflare";

// Every other binding (StandaloneGraphWorkflow, StandaloneTenants, OysterMcp,
// OysterRegistry, StandaloneWorkflowRuns, ComputerDO, OysterKeys,
// OysterWebhooks, StandaloneAgent, AgentDirectory) and the root fetch handler
// are unchanged; the local StandaloneInstance and MediaOperationDO exports
// below shadow the ones this re-exports, the same way
// loader-workflows-root.fixture.ts layers CanonicalRoot on top of this same
// base fixture. export * never carries the default export, so that is
// re-exported explicitly too.
export * from "./workflows-root.fixture.js";
export { default } from "./workflows-root.fixture.js";

// A controlled Workers AI provider for this proof only: deterministic image
// bytes for an ordinary image model, and a deterministic MP4 for the
// Seedance gateway model (apps/prints's real generateImage and
// generateVideo methods, and Darkroom's real
// createWorkersAiMediaProvider/generate, run completely unchanged against
// it; only the underlying env.AI binding and the gateway's follow-up GET of
// the video URL are faked, same boundary workers-media.test.mjs fakes).
// This fake MP4 is deliberately not decodable: success here proves the
// controlled-provider plumbing (Prints' real methods receive and return
// real-shaped bytes end to end), not playable media or live acceptance.
// Real, playable media stays a rehearsal leg (demo-e2e-coverage-2026-10-14.md
// S10).
//
// Media dispatch for the request path runs through the Instance Durable
// Object's own `env` (packages/oyster/src/standalone/instance.ts MEDIA.dispatch ->
// media.ts -> createWorkersAiMediaProvider(env.AI)); workflows-root.fixture.ts's
// own StandaloneInstance already substitutes env at that constructor seam for
// Git, and this subclass layers the controlled AI/IMAGES bindings on top of
// it, the same way loader-workflows-root.fixture.ts layers CANONICAL_ROOT on
// top. Video generation ALSO backgrounds through a second, separate seam:
// MediaOperationDO's own alarm (packages/darkroom/src/media-operation-do.ts),
// which builds its provider from ITS OWN `this.env.AI`, not the Instance's.
// Without the override below, that DO's env.AI is undefined (this Worker's
// wrangler config binds no "ai"), so the alarm throws "Media host has no
// provider" and the operation is marked interrupted -- root-caused in
// reviews/storyboard-video-interrupted-rootcause-2026-10-14.md. IMAGES is not
// needed on this DO: by the time a video reaches the alarm, its reference
// images are already resolved and stored (dispatchInBackground), so the
// background path never calls back into IMAGES.

// A real, minimal 1x1 transparent PNG, so format/dimension sniffing in
// darkroom's normalizeBytes succeeds exactly as it would for a real model.
const onePixelPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  ),
  (char) => char.codePointAt(0) ?? 0,
);
const fakeVideoUrl = "https://storyboard-proof-media.test/clip.mp4";
// Darkroom's isMp4 only sniffs the ftyp box signature at bytes 4-7
// (packages/darkroom/src/gateway-models.ts:180-185); this is deliberately
// minimal, not a decodable MP4.
const fakeMp4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

// darkroom's generate() only ever calls run(); the Ai binding's other
// members are declared so this object satisfies the Worker's full Env
// type, and are never reached by the real Prints/Darkroom code path.
function unused(member: string): never {
  throw new Error(
    `storyboard.native.mjs's controlled AI binding does not implement ${member}`,
  );
}
function controlledAi() {
  return {
    aiGatewayLogId: null,
    gateway() {
      return unused("gateway()");
    },
    websearch() {
      return unused("websearch()");
    },
    aiSearch() {
      return unused("aiSearch()");
    },
    autorag() {
      return unused("autorag()");
    },
    run(model: string) {
      if (model === "bytedance/seedance-2.0")
        return Promise.resolve({
          state: "Completed",
          result: { video: fakeVideoUrl },
        });
      return Promise.resolve(onePixelPng);
    },
  };
}

// The only image this fixture ever produces is onePixelPng above (every
// generateImage/generateVideo first-frame reference, end to end), so its
// metadata is already known rather than decoded: no hand-rolled PNG
// parsing. info() asserts the bytes it's handed are exactly those known
// bytes, then returns their already-known metadata -- a real Images
// binding would report the same fields for this same image.
async function knownImageInfo(input: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(await new Response(input).arrayBuffer());
  if (
    bytes.byteLength !== onePixelPng.byteLength ||
    !bytes.every((byte, index) => byte === onePixelPng[index])
  )
    throw new Error(
      "storyboard.native.mjs's controlled Images binding only recognizes its own onePixelPng fixture bytes",
    );
  return {
    format: "image/png" as const,
    fileSize: onePixelPng.byteLength,
    width: 1,
    height: 1,
  };
}

// Darkroom's reference fitter only calls input()/transform()/output() to
// scale an oversized reference down to MAX_REFERENCE_DIMENSION (512px;
// packages/darkroom/src/index.ts). This fixture's only reference is the 1x1
// onePixelPng, always under that bound, so the real code path never calls
// this chain; it stays unimplemented rather than inventing a fake resize.
function controlledImages() {
  return {
    info: knownImageInfo,
    input() {
      return unused("Images.input()");
    },
  };
}

// Darkroom's gateway video path fetches the result URL through the plain
// global fetch (packages/darkroom/src/cloudflare/provider.ts:134-171,
// createWorkersAiMediaProvider's default fetchResult), not through an env
// binding, so the only way to control it is to intercept that one URL at
// module scope, before any request is served. Every other fetch call in
// this Worker (artifact PUTs, publication, the local Git provider) also
// passes through this same global, so reading the URL must never
// reconstruct a Request: that consumes a POST body, and the real request
// could then never be forwarded. Request.prototype.url is a plain string
// property and reads it without touching the body.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === fakeVideoUrl)
    return Promise.resolve(new Response(fakeMp4, { status: 200 }));
  return nativeFetch(input, init);
};

export class StandaloneInstance extends GitWrappedInstance {
  constructor(
    ctx: ConstructorParameters<typeof GitWrappedInstance>[0],
    env: ConstructorParameters<typeof GitWrappedInstance>[1],
  ) {
    super(ctx, { ...env, AI: controlledAi(), IMAGES: controlledImages() });
  }
}

export class MediaOperationDO extends DarkroomMediaOperationDO {
  constructor(
    ctx: ConstructorParameters<typeof DarkroomMediaOperationDO>[0],
    env: ConstructorParameters<typeof DarkroomMediaOperationDO>[1],
  ) {
    super(ctx, { ...env, AI: controlledAi() });
  }
}
