import { base64url } from "jose";
import { expect, it } from "vitest";
import { loadPatternRedactor } from "@fungi.computer/veil/redaction";
import { createBuildJobLog } from "../../src/build/job-log.js";

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
    const redactor = await loadPatternRedactor();
    // The real redactor, counting every character the scan loop hands it.
    let scanned = 0;
    const capture = await createBuildJobLog(() =>
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
    );
    const bytes = new TextEncoder().encode(text);
    for (let at = 0; at < bytes.length; at += 997)
      capture.append(bytes.subarray(at, at + 997));
    const result = capture.finish();
    expect(scanned).toBeLessThan(3 * text.length);
    expect(result.truncated).toBeNull();
    const retained = new TextDecoder().decode(base64url.decode(result.output));
    expect(retained).not.toContain(token.slice(0, 12));
    expect(retained).not.toContain(token.slice(-12));
    expect(retained).toBe(redactor.redact(text).text);
  },
);
