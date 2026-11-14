// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished } from "vitest";
import { AppPermissionsView } from "../../src/page/app-permissions.js";
import {
  appCallTargetName,
  appPermissionPageSchema,
  unresolvedAppCallTarget,
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
    appCalls: [],
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
            fingerprints: {},
            resources: "tenant-scope",
          },
        ],
        approval: null,
      },
      declaredOperations: {
        artifactDigest: digest,
        digest,
        capabilities: [
          {
            capability: "team.workbenchHost",
            operations: [],
            fingerprints: {},
          },
          { capability: "agent.send", operations: [], fingerprints: {} },
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
                fingerprints: {},
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
  expect(
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow all 1",
    )?.disabled,
  ).toBe(true);
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
        declaredOperationsDigest: digest,
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
  expect(container.textContent).toContain("Permissions saved");
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
      appCalls: [],
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
          capabilities: [
            { capability: "agent.send", operations: [], fingerprints: {} },
          ],
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

it("lists each grant once under a sentence-case heading with a labelled switch and state in words", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const view = appPermissionPageSchema.parse({
    storeGeneration: "generation",
    installationId: "trellis",
    appId: "app_trellis",
    appName: "Trellis",
    appCalls: [
      {
        operation: "route:apps.call:app_bonsai:files.read",
        method: "files.read",
        targetName: "Bonsai",
      },
      {
        operation: "route:apps.call:app_missing:files.save",
        method: "files.save",
        targetName: unresolvedAppCallTarget,
      },
      {
        operation: "route:apps.call:app_other:files.save",
        method: "files.save",
        targetName: unresolvedAppCallTarget,
      },
    ],
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
        capabilities: [
          { capability: "agent.send", operations: [], fingerprints: {} },
          {
            capability: "apps.call",
            operations: [
              "route:apps.call:app_bonsai:files.read",
              "route:apps.call:app_missing:files.save",
              "route:apps.call:app_other:files.save",
              "route:app.methods:exportProject",
              "route:app.methods:archiveProject",
            ],
            fingerprints: {
              "route:apps.call:app_bonsai:files.read": "fingerprint",
              "route:apps.call:app_missing:files.save": "fingerprint",
              "route:apps.call:app_other:files.save": "fingerprint",
              "route:app.methods:exportProject": "fingerprint",
              "route:app.methods:archiveProject": "fingerprint",
            },
          },
        ],
      },
    },
  });
  const submitted: Parameters<AppPermissionsPort["submit"]>[] = [];
  const port: AppPermissionsPort = {
    read: () => Promise.resolve(view),
    submit: (...args) => {
      submitted.push(args);
      return Promise.resolve("refused");
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
  await act(() => {
    root.render(createElement(AppPermissionsView, { port, appKey: "trellis" }));
    return Promise.resolve();
  });
  expect(
    container.querySelector(".caps-permission-grid-title")?.textContent,
  ).toBe("Trellis permissions");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(7);
  expect(container.querySelector("tbody")?.textContent).toContain("Off");
  const toggle = container.querySelector<HTMLInputElement>(
    'input[aria-label="All Agents: Send messages to Agents"]',
  );
  if (toggle === null) throw new Error("Switch missing");
  expect(toggle.closest(".caps-switch")).not.toBeNull();
  await act(() => {
    toggle.click();
    return Promise.resolve();
  });
  expect(container.querySelector("tbody")?.textContent).toContain("On");
  expect(container.textContent).not.toContain("route:apps");
  expect(container.textContent).toContain("Read files");
  expect(container.textContent).toContain(unresolvedAppCallTarget);
  expect(container.textContent).not.toMatch(/app_|route:/u);
  const readFiles = container.querySelector<HTMLInputElement>(
    'input[aria-label="Bonsai: Read files"]',
  );
  if (readFiles === null) throw new Error("Bonsai call switch missing");
  await act(() => {
    readFiles.click();
    return Promise.resolve();
  });
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save permissions",
  );
  if (save === undefined) throw new Error("Save permissions missing");
  await act(() => {
    save.click();
    return Promise.resolve();
  });
  expect(
    submitted[0]?.[2].find((change) => change.capability === "apps.call"),
  ).toEqual({
    capability: "apps.call",
    grant: {
      resources: "tenant-scope",
      operations: ["route:apps.call:app_bonsai:files.read"],
    },
  });
});

it.each(["accepted", "refused", "unconfirmed", "stale", "viewer"] as const)(
  "Allow all saves the pending Grove grants once and only confirms acceptance: %s",
  async (outcome) => {
    const digest = `sha256:${"a".repeat(64)}`;
    let view = appPermissionPageSchema.parse({
      storeGeneration: "generation",
      installationId: "grove",
      appId: "app_grove",
      appName: "Grove",
      appCalls: [],
      artifactDigest: digest,
      canEdit: outcome !== "viewer",
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
          capabilities: [
            { capability: "approvals", operations: [], fingerprints: {} },
            { capability: "apps.open", operations: [], fingerprints: {} },
            {
              capability: "channels.personal.manage",
              operations: [],
              fingerprints: {},
            },
            { capability: "channels.read", operations: [], fingerprints: {} },
          ],
        },
      },
    });
    const submissions: Parameters<AppPermissionsPort["submit"]>[] = [];
    const port: AppPermissionsPort = {
      read: () => Promise.resolve(view),
      submit: (...args) => {
        submissions.push(args);
        if (outcome === "accepted") {
          view = appPermissionPageSchema.parse({
            ...view,
            permissions: {
              ...view.permissions,
              authority: {
                ...view.permissions.authority,
                authorityVersion: 2,
                approvedGrants: args[2].flatMap(({ capability, grant }) =>
                  grant === null
                    ? []
                    : [
                        {
                          capability,
                          capabilityApproved: true,
                          ...grant,
                          fingerprints: Object.fromEntries(
                            grant.operations.map((operation) => [
                              operation,
                              "fingerprint",
                            ]),
                          ),
                        },
                      ],
                ),
              },
            },
          });
        }
        return Promise.resolve(outcome === "viewer" ? "refused" : outcome);
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
    await act(() => {
      root.render(createElement(AppPermissionsView, { port, appKey: "grove" }));
      return Promise.resolve();
    });
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow all 3",
    );
    if (outcome === "viewer") {
      expect(allow).toBeUndefined();
      expect(submissions).toHaveLength(0);
      return;
    }
    expect(allow).toBeDefined();
    await act(() => {
      allow?.click();
      return Promise.resolve();
    });
    expect(submissions).toEqual([
      [
        "grove",
        {
          storeGeneration: "generation",
          authorityVersion: 1,
          artifactDigest: digest,
          declaredOperationsDigest: digest,
        },
        ["approvals", "channels.personal.manage", "channels.read"].map(
          (capability) => ({
            capability,
            grant: { operations: [], resources: "tenant-scope" },
          }),
        ),
      ],
    ]);
    if (outcome === "accepted") {
      expect(container.textContent).not.toContain("Allow all 3");
      expect(
        container.querySelectorAll("input:checked:not(:disabled)"),
      ).toHaveLength(3);
      expect(document.body.textContent).toContain(
        "Grove can now review approvals, manage personal channels, and read channels.",
      );
    } else {
      expect(document.body.textContent).not.toContain("Grove can now");
      expect(container.textContent).toContain(
        outcome === "refused"
          ? "was refused"
          : outcome === "stale"
            ? "Current permissions loaded"
            : "could not be confirmed",
      );
    }
  },
);

it("names an App-call target from the directory and never shows an id while it is unresolved", () => {
  const directory = {
    apps: [{ appId: "app_bonsai", displayName: "Bonsai" }],
    installing: [{ appId: "app_inkcap", displayName: "Inkcap" }],
  };
  expect(appCallTargetName(directory, "app_bonsai")).toBe("Bonsai");
  expect(appCallTargetName(directory, "app_inkcap")).toBe("Inkcap");
  for (const unresolved of [
    appCallTargetName(directory, "app_missing"),
    appCallTargetName({ apps: [{ appId: "app_inkcap" }] }, "app_inkcap"),
    appCallTargetName(null, "app_inkcap"),
  ]) {
    expect(unresolved).toBe(unresolvedAppCallTarget);
    expect(unresolved).not.toContain("app_");
  }
});
