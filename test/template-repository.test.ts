import { expect, it } from "vitest";
import {
  appForTemplateRepository,
  templateRepositoryForApp,
} from "../src/source/template-repository.js";

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

it("names the one App a template repository belongs to, or none", () => {
  for (const appId of ["app_shed", "app_media", `app_${"a".repeat(63)}`])
    expect(appForTemplateRepository(templateRepositoryForApp(appId))).toBe(
      appId,
    );
  for (const repository of [
    "notes",
    "template-",
    "template-../shed",
    "bonsai--template-shed",
    `template-${"a".repeat(64)}`,
  ])
    expect(appForTemplateRepository(repository)).toBeNull();
});
