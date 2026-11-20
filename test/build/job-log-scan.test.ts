import { base64url } from "jose";
import { expect, it } from "vitest";
import { loadPatternRedactor } from "@fungi.computer/veil/redaction";
import {
  createBuildJobLog,
  keyWithheld,
  redactionWithheld,
} from "../../src/build/job-log.js";

const token = ["ghp_", "7Zk9P2mQa4Wv6Xc8Bn0Ds3Fg5Hj1Lr9Ty2Ui"].join("");

/** About 2 MB of filler lines with a token every `gap` characters. */
function stream(gap: number): string {
  const filler = `${"x".repeat(79)}\n`;
  const unit = `${filler.repeat(Math.floor((gap - token.length - 1) / filler.length))}${"y".repeat((gap - token.length - 1) % filler.length)}${token}\n`;
  return unit.repeat(Math.floor(2_000_000 / unit.length));
}

// 4096 puts a token in the tail of every scan; 16_397 drifts a token across
// every window-sized cut position as the stream advances.
it.each([4096, 16_397])(
  "scans a token every %i characters in linear time with one-shot results",
  async (gap) => {
    const text = stream(gap);
    const { scanned, truncated, retained, oneShot } = await scanThrough(
      text,
      every(text, 997),
    );
    expect(scanned).toBeLessThan(3 * text.length);
    expect(truncated).toBeNull();
    expect(retained).not.toContain(token.slice(0, 12));
    expect(retained).not.toContain(token.slice(-12));
    expect(retained).toBe(oneShot());
  },
);

/** Event boundaries every `size` characters of an ASCII `text`. */
const every = (text: string, size: number) =>
  Array.from(
    { length: Math.ceil(text.length / size) - 1 },
    (_, index) => (index + 1) * size,
  );

/**
 * Feeds `text` in `chunk`-byte events through the real scan loop and the real
 * redactor, counting every character the loop hands its full rule scan.
 * `pendingCeiling` lowers the held-text ceiling for the cases that cross it.
 */
async function scanThrough(
  text: string,
  cuts: readonly number[],
  pendingCeiling?: number,
) {
  const redactor = await loadPatternRedactor();
  let scanned = 0;
  const capture = await createBuildJobLog(
    () =>
      Promise.resolve({
        ...redactor,
        find: (input: string) => {
          scanned += input.length;
          return redactor.find(input);
        },
        redact: (input: string) => {
          scanned += input.length;
          return redactor.redact(input);
        },
      }),
    pendingCeiling,
  );
  // `cuts` are the event boundaries after the first event's start.
  const bytes = new TextEncoder().encode(text);
  const starts = [0, ...cuts];
  for (const [index, at] of starts.entries())
    capture.append(bytes.subarray(at, starts[index + 1] ?? bytes.length));
  // Text held from its start is released before the end only by the ceiling.
  const releasedBeforeEnd = capture.allocatedBytes > 0;
  const result = capture.finish();
  return {
    scanned,
    releasedBeforeEnd,
    truncated: result.truncated,
    retained: new TextDecoder().decode(base64url.decode(result.output)),
    oneShot: () => redactor.redact(text).text,
  };
}

/** Deterministic base64 key-body lines, assembled so scanners see no key. */
function keyBody(lines: number, from = 7): string[] {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = from;
  return Array.from({ length: lines }, () =>
    Array.from({ length: 64 }, () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return alphabet[(seed >>> 16) % 64];
    }).join(""),
  );
}
const begin = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const end = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const filler = (characters: number) =>
  `${"x".repeat(79)}\n`.repeat(Math.ceil(characters / 80));
// Eight scan windows: the ceiling cases cross it with the same ratios as the
// 1 MiB production ceiling, on an eighth of the text.
const ceiling = 128 * 1024;

it("holds a private key whose body is split by more than a scan window", async () => {
  const body = keyBody(25);
  const text = `${filler(4000)}${begin}\n${body.slice(0, 10).join("\n")}\n${filler(40_000)}${body.slice(10).join("\n")}\n${end}\n${filler(40_000)}`;
  const { retained, oneShot } = await scanThrough(text, every(text, 61));
  for (const line of body) expect(retained).not.toContain(line);
  expect(retained).toBe(oneShot());
});

it("ends the log with a note when a private key opens and never closes", async () => {
  const body = keyBody(10);
  const text = `ok\n${begin}\n${body.join("\n")}\n`;
  const { retained } = await scanThrough(text, every(text, 61));
  for (const line of body) expect(retained).not.toContain(line);
  expect(retained).toContain("ok\n");
  expect(retained.trimEnd().endsWith(keyWithheld)).toBe(true);
  expect(keyWithheld).toContain("output withheld until the key ends");
});

it("ends the log with the note when a key past the ceiling never closes", async () => {
  const body = keyBody(10);
  const text = `${begin}\n${body.join("\n")}\n${filler(3 * ceiling)}`;
  const { retained, releasedBeforeEnd } = await scanThrough(
    text,
    every(text, 4096),
    ceiling,
  );
  expect(releasedBeforeEnd).toBe(true);
  for (const line of body) expect(retained).not.toContain(line);
  expect(retained.trimEnd().endsWith(keyWithheld)).toBe(true);
});

it("adds no note when a private key closes", async () => {
  const text = `${begin}\n${keyBody(10).join("\n")}\n${end}\nafter\n`;
  const { retained, oneShot } = await scanThrough(text, every(text, 61));
  expect(retained).not.toContain("withheld");
  expect(retained).toBe(oneShot());
});

it("adds no key note for an unfinished curl command", async () => {
  const text = `curl https://x.test/ -u builder:`;
  const open = (await loadPatternRedactor()).openFrom(text);
  // The input really opens a hold, so the assertions below are not vacuous.
  expect(open?.ruleId).toMatch(/^curl-auth-/);
  const { retained } = await scanThrough(text, []);
  expect(retained).not.toContain("curl https://x.test/");
  expect(retained).toContain("[REDACTED]");
  expect(retained).not.toContain(keyWithheld);
});

it("holds a curl command whose credentials arrive past a scan window on its line", async () => {
  const password = ["s3cr3t", "Passw0rd"].join("");
  const text = `${filler(4000)}curl https://example.test/${"q".repeat(40_000)} -u builder:${password}\n${filler(40_000)}`;
  const { retained, oneShot } = await scanThrough(text, every(text, 61));
  expect(oneShot()).not.toContain(password);
  expect(retained).not.toContain(password);
  expect(retained).toBe(oneShot());
});

it("masks an unfinished private key whole at the ceiling and stays linear", async () => {
  const body = keyBody(25);
  const text = `${begin}\n${body.slice(0, 10).join("\n")}\n${filler(3 * ceiling)}${body.slice(10).join("\n")}\n`;
  const { scanned, retained, releasedBeforeEnd } = await scanThrough(
    text,
    every(text, 4096),
    ceiling,
  );
  expect(releasedBeforeEnd).toBe(true);
  for (const line of body) expect(retained).not.toContain(line);
  expect(scanned).toBeLessThan(4 * text.length);
});

// One event far past the ceiling, or ordinary events that reach it.
it.each([0, 4096])(
  "masks a private key through an end line that arrives after the ceiling (%i-byte events, or one past it)",
  async (size) => {
    const body = keyBody(10);
    const remainder = ["TAILSECRET", "zz9"].join("");
    const head = `${begin}\n${body.join("\n")}\n`.padEnd(
      Math.ceil(1.1 * ceiling),
      "y",
    );
    for (const after of ["after\n", `after\n${"z\n".repeat(30_000)}`]) {
      const text = `${head}${remainder}\n${end}\n${after}`;
      const { retained, releasedBeforeEnd } = await scanThrough(
        text,
        size === 0 ? [head.length] : every(text, size),
        ceiling,
      );
      expect(releasedBeforeEnd).toBe(true);
      for (const line of [...body, remainder])
        expect(retained).not.toContain(line);
      expect(retained.endsWith(after)).toBe(true);
    }
  },
);

it("holds a curl command across bare carriage returns, which RE2's `.` spans", async () => {
  const password = ["s3cr3t", "Passw0rd"].join("");
  const text = `curl https://x.test/${"p\r".repeat(20)}${"q".repeat(60_000)} -u builder:${password}\n${"f\n".repeat(30_000)}`;
  const { retained, oneShot } = await scanThrough(text, every(text, 61));
  expect(oneShot()).not.toContain(password);
  expect(retained).not.toContain(password);
  expect(retained).toBe(oneShot());
});

// Three keys with LF or CRLF, filler up to 40 KB before each and up to 30 KB
// inside each, at event sizes that split every BEGIN and END line somewhere.
it.each(
  [1, 7, 61, 997, 4096, 20_000].flatMap((size) =>
    ["\n", "\r\n"].map((newline) => [size, newline] as const),
  ),
)(
  "matches one-shot redaction for interrupted keys in %i-byte events with %j",
  async (size, nl) => {
    const variant = size + nl.length;
    const text = [0, 1, 2]
      .map(
        (key) =>
          `${"z".repeat((variant * 977 + key * 31_337) % 40_000)}${nl}${begin}${nl}${keyBody(12, variant * 100 + key * 13).join(nl)}${nl}${"w".repeat((variant * 131 + key * 7919) % 30_000)}${nl}${end}${nl}`,
      )
      .join("")
      .concat("end".repeat(100));
    const { retained, oneShot } = await scanThrough(text, every(text, size));
    expect(retained).toBe(oneShot());
  },
  20_000,
);

it("matches one-shot redaction when an event splits the BEGIN line", async () => {
  const body = keyBody(10);
  const text = `${"a".repeat(20_000)}${begin}\n${body.join("\n")}\n${"w".repeat(20_000)}\n${end}\n${"b".repeat(20_000)}`;
  const split = text.indexOf("-----BEG") + 8;
  const { retained, oneShot } = await scanThrough(text, [split, split + 5000]);
  for (const line of body) expect(retained).not.toContain(line);
  expect(retained).toBe(oneShot());
});

it("withholds the whole log when the redactor fails to load, as a changed rule table makes it", async () => {
  const capture = await createBuildJobLog(() =>
    Promise.reject(
      new Error(
        "redaction rule private-key no longer has the span it is held by",
      ),
    ),
  );
  capture.append(
    new TextEncoder().encode(`${begin}\n${keyBody(3).join("\n")}\n`),
  );
  const result = capture.finish();
  expect(new TextDecoder().decode(base64url.decode(result.output))).toBe(
    redactionWithheld,
  );
});
