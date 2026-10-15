import { expect, it } from "vitest";
import { templateRepositoryForApp } from "../src/source/template-repository.js";

it("derives a bounded source repository from each validated App identity", () => {
  expect(templateRepositoryForApp("app_media")).toBe("template-media");
  expect(templateRepositoryForApp("app_shed")).toBe("template-shed");
  expect(templateRepositoryForApp("app_mediaproof")).toBe(
    "template-mediaproof",
  );
  expect(templateRepositoryForApp("app_shedproof")).toBe("template-shedproof");

  const longestAppId = `app_${"a".repeat(63)}`;
  const longestRepository = templateRepositoryForApp(longestAppId);
  expect(longestRepository).toBe(`template-${"a".repeat(63)}`);
  expect(longestRepository.length).toBeLessThanOrEqual(128);
});

it("rejects values outside the App Release AppId grammar", () => {
  expect(() => templateRepositoryForApp("../template-shed")).toThrow();
  expect(() => templateRepositoryForApp(`app_${"a".repeat(64)}`)).toThrow();
});
