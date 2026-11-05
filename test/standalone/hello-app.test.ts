import { helloAppScript } from "#hello-app-script";
import { describe, expect, it } from "vitest";
import { helloPage } from "../../src/standalone/hello-app.js";

describe("starter Hello App", () => {
  it("loads a script that connects the page to Oyster", () => {
    // Oyster's CSP allows only same-origin scripts; the page never announces
    // itself otherwise and its window reports "didn't respond in time".
    expect(helloPage).toContain('<script type="module" src="./main.js">');
    // One self-contained module: bare imports cannot resolve in the frame.
    expect(helloAppScript).not.toMatch(/^import[ {*"']/m);
    expect(helloAppScript.length).toBeGreaterThan(0);
  });
});
