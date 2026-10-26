import { expect, it } from "vitest";
import { candidateFailureDiagnostic } from "../../src/build/candidate-diagnostic.js";

it("shows a bounded, redacted builder exception and its causes", () => {
  const thrown = new Error(
    "compile failed bearer secret-123456789012345678901234",
    {
      cause: new Error("install failed", {
        cause: new Error("registry refused"),
      }),
    },
  );
  const detail = candidateFailureDiagnostic(thrown);
  expect(detail).toContain("compile failed");
  expect(detail).toContain("Caused by: install failed");
  expect(detail).toContain("Caused by: registry refused");
  expect(detail).not.toContain("secret-123456789012345678901234");
  expect(detail.length).toBeLessThanOrEqual(200);
});
