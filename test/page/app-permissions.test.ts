// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished } from "vitest";
import { AppPermissionsView } from "../../src/page/app-permissions.js";
import {
  appPermissionPageSchema,
  type AppPermissionsPort,
  type AppPermissionsViewData,
} from "../../src/apps/permissions.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

it("Shell uses one compact row and inline confirmation, saving every pending permission together", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  let view = appPermissionPageSchema.parse({
    storeGeneration: "generation",
    installationId: "desktop",
    appId: "app_tourtois",
    appName: "Tourtois",
    artifactDigest: digest,
    canEdit: true,
    resources: [],
    permissions: {
      authority: {
        authorityVersion: 1,
        declaredOperationsDigest: digest,
        approvedGrants: [
          {
            capability: "team.workbenchHost",
            capabilityApproved: true,
            operations: [],
            resources: "tenant-scope",
          },
        ],
        approval: null,
      },
      declaredOperations: {
        artifactDigest: digest,
        digest,
        capabilities: [
          { capability: "team.workbenchHost", operations: [] },
          { capability: "agent.send", operations: [] },
        ],
      },
    },
  });
  const submissions: Parameters<AppPermissionsPort["submit"]>[] = [];
  const port: AppPermissionsPort = {
    read: () => Promise.resolve(view),
    submit: (...args) => {
      submissions.push(args);
      view = appPermissionPageSchema.parse({
        ...view,
        permissions: {
          ...view.permissions,
          authority: {
            ...view.permissions.authority,
            authorityVersion: 2,
            approvedGrants: [
              {
                capability: "agent.send",
                capabilityApproved: true,
                operations: [],
                resources: "tenant-scope",
              },
            ],
          },
        },
      });
      return Promise.resolve("accepted");
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(() => {
      root.unmount();
      return Promise.resolve();
    });
    container.remove();
  });
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (button === undefined) throw new Error(`Missing action: ${label}`);
    await act(() => {
      button.click();
      return Promise.resolve();
    });
  };
  await act(() => {
    root.render(createElement(AppPermissionsView, { port, appKey: "desktop" }));
    return Promise.resolve();
  });
  expect(container.textContent).toContain(
    "Full access to your Team and every App",
  );
  expect(container.textContent).not.toContain("Shell (full access)");
  expect(container.textContent).not.toContain(
    "run as your Team's trusted shell",
  );
  expect(
    container.querySelector('input[aria-label="Shell (full access)"]'),
  ).toBeNull();
  expect(
    container.querySelector('[aria-label="Shell allowed"]'),
  ).not.toBeNull();
  await click("Revoke");
  expect(container.textContent).toContain("Revoke Shell access?");
  expect(submissions).toHaveLength(0);
  await click("Cancel");
  expect(container.textContent).not.toContain("Revoke Shell access?");
  expect(submissions).toHaveLength(0);
  const agent = container.querySelector<HTMLInputElement>(
    'input[aria-label="All Agents: Send messages to Agents"]',
  );
  if (agent === null) throw new Error("Approved Agent verb key missing");
  await act(() => {
    agent.click();
    return Promise.resolve();
  });
  await click("Revoke");
  expect(container.textContent).toContain("Save all permission edits");
  expect(
    [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Save permissions",
    ),
  ).toHaveLength(1);
  await click("Save permissions");
  expect(submissions).toEqual([
    [
      "desktop",
      {
        storeGeneration: "generation",
        authorityVersion: 1,
        artifactDigest: digest,
      },
      [
        { capability: "team.workbenchHost", grant: null },
        {
          capability: "agent.send",
          grant: { operations: [], resources: "tenant-scope" },
        },
      ],
    ],
  ]);
  expect(container.textContent).toContain("Permissions saved.");
  expect(
    container.querySelector('[aria-label="Shell not allowed"]'),
  ).not.toBeNull();
});

it("changing Apps never exposes the previous App's editable draft while the new facts load", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const view = (installationId: string) =>
    appPermissionPageSchema.parse({
      storeGeneration: "generation",
      installationId,
      appId: "app_probe",
      appName: installationId,
      artifactDigest: digest,
      canEdit: true,
      resources: [],
      permissions: {
        authority: {
          authorityVersion: 1,
          declaredOperationsDigest: digest,
          approvedGrants: [],
          approval: null,
        },
        declaredOperations: {
          artifactDigest: digest,
          digest,
          capabilities: [{ capability: "agent.send", operations: [] }],
        },
      },
    });
  let finishRead: (next: AppPermissionsViewData) => void = () => {
    throw new Error("Second App read has not started");
  };
  const port: AppPermissionsPort = {
    read: (appKey) =>
      appKey === "first"
        ? Promise.resolve(view("first"))
        : new Promise((resolve) => {
            finishRead = resolve;
          }),
    submit: () => Promise.resolve("refused"),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(() => {
      root.unmount();
      return Promise.resolve();
    });
    container.remove();
  });
  await act(() => {
    root.render(createElement(AppPermissionsView, { port, appKey: "first" }));
    return Promise.resolve();
  });
  const first = container.querySelector<HTMLInputElement>(
    'input[aria-label="All Agents: Send messages to Agents"]',
  );
  if (first === null) throw new Error("First App permission missing");
  await act(() => {
    first.click();
    return Promise.resolve();
  });
  expect(first.checked).toBe(true);
  await act(() => {
    root.render(createElement(AppPermissionsView, { port, appKey: "second" }));
    return Promise.resolve();
  });
  expect(container.textContent).toContain("Loading permissions");
  expect(container.querySelector("input")).toBeNull();
  await act(() => {
    finishRead(view("second"));
    return Promise.resolve();
  });
  expect(container.querySelector<HTMLInputElement>("input")?.checked).toBe(
    false,
  );
});
