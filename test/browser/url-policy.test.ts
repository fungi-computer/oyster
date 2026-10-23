import { describe, expect, it } from "vitest";
import { assertCloudBrowserUrlAllowed } from "../../src/browser/url-policy.js";
import { CloudBrowserUrlDenied } from "../../src/browser/errors.js";

/** A fake resolver so tests never make a real DNS lookup. */
function resolverFor(answers: Readonly<Record<string, readonly string[]>>) {
  return (hostname: string) => Promise.resolve(answers[hostname] ?? []);
}

async function denial(
  url: string,
  resolve: ReturnType<typeof resolverFor>,
): Promise<CloudBrowserUrlDenied> {
  try {
    await assertCloudBrowserUrlAllowed(url, {
      resolve,
      signal: new AbortController().signal,
    });
  } catch (error) {
    if (error instanceof CloudBrowserUrlDenied) return error;
    throw error;
  }
  throw new Error(`expected ${url} to be denied`);
}

describe("cloud browser URL policy", () => {
  it("denies a loopback literal", async () => {
    const error = await denial("http://127.0.0.1/", resolverFor({}));
    expect(error.reason).toBe("not_public");
  });

  it("denies the cloud metadata address", async () => {
    const error = await denial(
      "http://169.254.169.254/latest",
      resolverFor({}),
    );
    expect(error.reason).toBe("not_public");
  });

  it("denies a private 10/8 literal", async () => {
    const error = await denial("http://10.1.2.3/", resolverFor({}));
    expect(error.reason).toBe("not_public");
  });

  it("denies a hostname that rebinds to a private address", async () => {
    const error = await denial(
      "https://rebinding.example/",
      resolverFor({ "rebinding.example": ["10.0.0.5"] }),
    );
    expect(error.reason).toBe("not_public");
  });

  it("denies a non-http(s) scheme", async () => {
    const error = await denial("ftp://example.com/", resolverFor({}));
    expect(error.reason).toBe("unsupported_scheme");
  });

  it("denies a URL carrying credentials", async () => {
    const error = await denial(
      "https://user:pass@example.com/",
      resolverFor({ "example.com": ["93.184.215.14"] }),
    );
    expect(error.reason).toBe("credentials_in_url");
  });

  it("denies an unparseable URL", async () => {
    const error = await denial("not a url", resolverFor({}));
    expect(error.reason).toBe("invalid_url");
  });

  it("allows a public address and strips the fragment", async () => {
    const checked = await assertCloudBrowserUrlAllowed(
      "https://example.com/page#section",
      {
        resolve: resolverFor({ "example.com": ["93.184.215.14"] }),
        signal: new AbortController().signal,
      },
    );
    expect(checked.href).toBe("https://example.com/page");
  });
});
