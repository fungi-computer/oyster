import * as z from "zod";
import { expect, it } from "vitest";
import { appCatalogResponseSchema } from "../../src/shell/app-directory.js";

it("emits a bounded catalog method response schema for Tourtois", () => {
  const projection = z.toJSONSchema(appCatalogResponseSchema, { io: "output" });
  expect(projection.type).toBe("object");
  expect(
    appCatalogResponseSchema.parse({
      apps: [
        {
          surfaceId: "default:app_grove",
          appId: "app_grove",
          displayName: "Grove",
          gills: [
            { id: "inbox", title: "Inbox", desktop: { sizes: ["S", "M"] } },
          ],
        },
      ],
      roles: { inbox: { surfaceId: "default:app_grove", chosen: true } },
    }),
  ).toEqual({
    apps: [
      {
        surfaceId: "default:app_grove",
        appId: "app_grove",
        displayName: "Grove",
        gills: [
          { id: "inbox", title: "Inbox", desktop: { sizes: ["S", "M"] } },
        ],
      },
    ],
    roles: { inbox: { surfaceId: "default:app_grove", chosen: true } },
  });
});

it("refuses oversized catalog pages and Gill sets rather than silently truncating", () => {
  const app = { surfaceId: "default:app_grove", appId: "app_grove", gills: [] };
  expect(() =>
    appCatalogResponseSchema.parse({
      apps: Array.from({ length: 51 }, () => app),
      roles: {},
    }),
  ).toThrow();
  expect(() =>
    appCatalogResponseSchema.parse({
      apps: [
        {
          ...app,
          gills: Array.from({ length: 17 }, (_, id) => ({
            id: `gill_${String(id)}`,
            title: "Gill",
          })),
        },
      ],
      roles: {},
    }),
  ).toThrow();
  expect(() =>
    appCatalogResponseSchema.parse({
      apps: [{ ...app, grants: [] }],
      roles: {},
    }),
  ).toThrow();
});

it("preserves Gill placement rules in the representable catalog wire", () => {
  const repository = {
    key: "repo",
    label: "Repository",
    kind: "repository",
    required: true,
    options: "repos.options",
  };
  const catalog = (params: (typeof repository)[]) => ({
    apps: [
      {
        surfaceId: "default:app_bonsai",
        appId: "app_bonsai",
        gills: [{ id: "changes", title: "Changes", params }],
      },
    ],
    roles: {},
  });
  expect(appCatalogResponseSchema.parse(catalog([repository]))).toEqual(
    catalog([repository]),
  );
  for (const params of [
    [repository, repository],
    [{ ...repository, kind: "computer" }],
    [{ ...repository, key: " " }],
    [{ ...repository, extra: true }],
    [{ ...repository, label: "x".repeat(257) }],
    Array.from({ length: 5 }, (_, index) => ({
      ...repository,
      key: `repo_${String(index)}`,
    })),
  ]) {
    expect(appCatalogResponseSchema.safeParse(catalog(params)).success).toBe(
      false,
    );
  }
});
