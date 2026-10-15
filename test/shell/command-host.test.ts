import { AppError } from "@fungi.computer/agar/errors";
import type { AppHostHandlers } from "@fungi.computer/agar/host";
import { createWhistle, type WhistleRuntime } from "@fungi.computer/whistle";
import { describe, expect, it, vi } from "vitest";
import {
  commandPaletteReservedChordForPlatform,
  createAppSurfaceCommandHost,
  type AppCommandDeclaration,
} from "../../src/shell/command-host.js";

const command = (id: string, title = id) => ({
  category: "editor",
  id,
  projections: { menu: {} },
  title,
});
const declarations = (
  ...commands: readonly ReturnType<typeof command>[]
): readonly AppCommandDeclaration[] => commands;

type Invoke = Parameters<AppHostHandlers["registerCommands"]>[0]["invoke"];

describe("Hub App surface command host", () => {
  it("owns pane identities, multiple leases and their complete disposal", async () => {
    const host = createAppSurfaceCommandHost();
    const pane = host.mountPane("conversation:one");
    const other = host.mountPane("conversation:two");
    const first = pane.contribute([
      { ...command("first"), handler: () => "first" },
    ]);
    const second = pane.contribute([
      { ...command("second"), handler: () => "second" },
    ]);
    other.contribute([{ ...command("first"), handler: () => "other" }]);
    expect(pane.snapshot().menu).toHaveLength(2);
    expect(
      new Set(pane.snapshot().menu.map((row) => row.commandId.split(":")[0]))
        .size,
    ).toBe(1);
    expect(() =>
      pane.contribute([{ ...command("first"), handler: () => undefined }]),
    ).toThrow("command ID");
    expect(new Set(host.snapshot().menu.map((row) => row.commandId)).size).toBe(
      3,
    );
    expect(() => host.mountPane("conversation:one")).toThrow("already active");
    expect(() => host.mount("conversation:one", [])).toThrow("already active");
    expect(() => host.mountPane(" ")).toThrow("blank");

    host.focus("conversation:one");
    const oldId = pane
      .snapshot()
      .menu.find((row) => row.title === "first")?.commandId;
    if (oldId === undefined) throw new Error("first command absent");
    first.update([{ ...command("replacement"), handler: () => "replacement" }]);
    expect(pane.snapshot().menu.map((row) => row.title)).toEqual([
      "replacement",
      "second",
    ]);
    expect(await pane.execute(oldId, { origin: "menu" })).toEqual({
      status: "missing",
    });
    const listener = vi.fn();
    pane.subscribe(listener);
    pane.dispose();
    expect(host.active().menu).toEqual([]);
    expect(pane.snapshot().menu).toEqual([]);
    expect(host.snapshot().menu).toHaveLength(1);
    second.update([{ ...command("stale"), handler: () => undefined }]);
    second.dispose();
    pane.dispose();
    expect(() => pane.contribute([])).toThrow("disposed");
    const replacement = host.mountPane("conversation:one");
    replacement.contribute([{ ...command("new"), handler: () => undefined }]);
    expect(listener).not.toHaveBeenCalled();
    host.dispose();
    expect(replacement.snapshot().menu).toEqual([]);
    replacement.dispose();
    other.dispose();
  });

  it("admits unprojected catalog actions only in their owning focused pane", async () => {
    const host = createAppSurfaceCommandHost();
    const first = host.mountPane("first");
    const second = host.mountPane("second");
    const lease = first.contribute([
      {
        id: "catalog-action",
        title: "Change",
        category: "Fixture",
        handler: () => "changed",
      },
    ]);
    const id = first.commandId("catalog-action");
    host.focus("first");
    expect(await first.execute(id, { origin: "menu" })).toMatchObject({
      status: "handled",
    });
    for (const origin of ["menu", "programmatic", "agent"] as const)
      expect(await second.execute(id, { origin })).toEqual({
        status: "missing",
      });
    expect(await first.execute(id, { origin: "agent" })).toEqual({
      status: "missing",
    });
    host.focus("second");
    expect(await first.execute(id, { origin: "menu" })).toEqual({
      status: "missing",
    });
    expect(await first.execute(id, { origin: "programmatic" })).toMatchObject({
      status: "handled",
    });
    lease.update([]);
    expect(await first.execute(id, { origin: "programmatic" })).toEqual({
      status: "missing",
    });
    host.dispose();
  });

  it("reserves the leader chord on pane contributions and updates", () => {
    const host = createAppSurfaceCommandHost();
    const pane = host.mountPane("one");
    const row = {
      ...command("row"),
      handler: () => undefined,
      projections: { bindings: { values: ["ctrl+k"] } },
    };
    expect(() => pane.contribute([row])).toThrow("reserved leader chord");
    const lease = pane.contribute([{ ...row, projections: { menu: {} } }]);
    expect(() => {
      lease.update([row]);
    }).toThrow("reserved leader chord");
    expect(pane.snapshot().menu).toHaveLength(1);
    host.dispose();
  });

  it("reserves Cmd-K on Mac and Ctrl-K elsewhere for App iframe forwarding", () => {
    expect(commandPaletteReservedChordForPlatform(true)).toMatchObject({
      ctrlKey: false,
      metaKey: true,
    });
    expect(commandPaletteReservedChordForPlatform(false)).toMatchObject({
      ctrlKey: true,
      metaKey: false,
    });
  });

  it("registers Agent actions from a default App surface identity", async () => {
    const host = createAppSurfaceCommandHost();
    const invoke = vi.fn<Invoke>((id) => Promise.resolve(id));
    const mount = host.mount("default:app_mediaproof", [
      {
        category: "Image generation",
        id: "inspect-generation-draft",
        projections: { agent: {} },
        title: "Inspect image draft",
      },
    ]);
    try {
      await mount.handlers.registerCommands({
        commands: [
          {
            category: "Image generation",
            id: "inspect-generation-draft",
            projections: { agent: {} },
            title: "Inspect image draft",
          },
        ],
        invoke,
      });
      const row = host.snapshot().agent[0];
      if (row === undefined)
        throw new Error("Missing registered Agent command");
      expect(row.commandId).toBe(
        "default%3Aapp_mediaproof:inspect-generation-draft",
      );
      await expect(
        host.execute(row.commandId, { origin: "agent" }),
      ).resolves.toMatchObject({
        status: "handled",
        result: "inspect-generation-draft",
      });
    } finally {
      mount.dispose();
      host.dispose();
    }
  });

  it("refuses an App command that is absent from its verified Release declaration", async () => {
    const host = createAppSurfaceCommandHost();
    const mount = host.mount("untrusted-app", [command("declared")]);
    try {
      await expect(
        mount.handlers.registerCommands({
          commands: [command("undeclared")],
          invoke: vi.fn<Invoke>(() => Promise.resolve(undefined)),
        }),
      ).rejects.toMatchObject({
        code: "COMMAND_NOT_DECLARED",
        retryable: false,
      });
      await expect(
        mount.handlers.registerCommands({
          commands: [{ ...command("declared"), title: "Spoofed title" }],
          invoke: vi.fn<Invoke>(() => Promise.resolve(undefined)),
        }),
      ).rejects.toMatchObject({
        code: "COMMAND_NOT_DECLARED",
        retryable: false,
      });
      expect(host.snapshot().palette).toEqual([]);
    } finally {
      mount.dispose();
      host.dispose();
    }
  });

  it("rejects undeclared commands added by an App contribution update", async () => {
    const host = createAppSurfaceCommandHost();
    const mount = host.mount("updating-app", [command("declared")]);
    try {
      const contribution = await mount.handlers.registerCommands({
        commands: [command("declared")],
        invoke: vi.fn<Invoke>(() => Promise.resolve(undefined)),
      });
      host.focus("updating-app");
      expect(host.menu().map((row) => row.commandId)).toEqual([
        "updating-app:declared",
      ]);

      const update = Promise.resolve().then(() => {
        contribution.update([command("injected")]);
      });
      await expect(update).rejects.toBeInstanceOf(AppError);
      await expect(update).rejects.toMatchObject({
        code: "COMMAND_NOT_DECLARED",
        retryable: false,
      });
      expect(host.menu().map((row) => row.commandId)).toEqual([
        "updating-app:declared",
      ]);
    } finally {
      mount.dispose();
      host.dispose();
    }
  });

  it("advertises Release command rows before mount and routes them to the App opener", async () => {
    const host = createAppSurfaceCommandHost();
    const run = vi.fn(() => Promise.resolve());
    const dispose = host.registerDirectoryCommands(
      [
        {
          surfaceId: "installation:demo",
          appTitle: "Demo",
          command: {
            id: "open-project",
            title: "Open project",
            category: "Workspace",
            projections: { palette: {} },
          },
        },
      ],
      run,
    );
    try {
      const row = host.snapshot().palette[0];
      if (row === undefined) throw new Error("Missing directory command");
      expect(row).toMatchObject({
        category: "Demo · Workspace",
        title: "Open project",
      });
      expect(row.commandId).toBe(
        "app-directory:installation%3Ademo-open-project",
      );
      await expect(
        host.execute(row.commandId, { origin: "palette" }),
      ).resolves.toMatchObject({ status: "handled" });
      expect(run).toHaveBeenCalledWith("installation:demo", "open-project");
    } finally {
      dispose();
      host.dispose();
    }
  });

  it("keeps mounted contributions together and executes only the focused menu", async () => {
    const host = createAppSurfaceCommandHost();
    const inkcapInvoke = vi.fn<Invoke>((id) => Promise.resolve(`inkcap:${id}`));
    const mediaInvoke = vi.fn<Invoke>((id) => Promise.resolve(`media:${id}`));
    const inkcapMount = host.mount("inkcap-window", [command("save")]);
    const mediaMount = host.mount("media-window", [command("open")]);
    await inkcapMount.handlers.registerCommands({
      commands: [command("save")],
      invoke: inkcapInvoke,
    });
    await mediaMount.handlers.registerCommands({
      commands: [command("open")],
      invoke: mediaInvoke,
    });

    host.focus("inkcap-window");
    expect(host.menu().map((row) => row.commandId)).toEqual([
      "inkcap-window:save",
    ]);
    await expect(
      host.execute("inkcap-window:save", { origin: "menu" }),
    ).resolves.toMatchObject({ status: "handled", result: "inkcap:save" });
    expect(inkcapInvoke.mock.calls[0]?.[0]).toBe("save");
    expect(inkcapInvoke.mock.calls[0]?.[1]?.origin).toBe("menu");
    expect(inkcapInvoke.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(mediaInvoke).not.toHaveBeenCalled();

    host.focus("media-window");
    expect(host.menu().map((row) => row.commandId)).toEqual([
      "media-window:open",
    ]);
    await expect(
      host.execute("inkcap-window:save", { origin: "menu" }),
    ).resolves.toEqual({ status: "missing" });
    await expect(
      host.execute("inkcap-window:save", { origin: "programmatic" }),
    ).resolves.toMatchObject({ status: "handled", result: "inkcap:save" });
    expect(inkcapInvoke.mock.calls[1]?.[1]?.origin).toBe("programmatic");
    inkcapMount.dispose();
    mediaMount.dispose();
    host.dispose();
  });

  it("scopes each window so two Apps can share a slash alias and key", async () => {
    const host = createAppSurfaceCommandHost();
    const shared = {
      category: "File",
      id: "new",
      title: "New",
      projections: {
        slash: { aliases: ["new"] },
        bindings: { values: ["mod+n"] },
        palette: {},
      },
    };
    const first = host.mount("first-window", [shared]);
    const second = host.mount("second-window", [shared]);
    const firstInvoke = vi.fn<Invoke>((id) => Promise.resolve(`first:${id}`));
    await first.handlers.registerCommands({
      commands: [shared],
      invoke: firstInvoke,
    });
    await expect(
      second.handlers.registerCommands({
        commands: [shared],
        invoke: (id) => Promise.resolve(`second:${id}`),
      }),
    ).resolves.toBeDefined();

    host.focus("second-window");
    expect(host.active().slash.map((row) => row.commandId)).toEqual([
      "second-window:new",
    ]);
    expect(host.active().palette.map((row) => row.commandId)).toEqual([
      "second-window:new",
    ]);
    await expect(
      host.execute("second-window:new", { origin: "keyboard" }),
    ).resolves.toMatchObject({ status: "handled", result: "second:new" });
    await expect(
      host.execute("first-window:new", { origin: "keyboard" }),
    ).resolves.toEqual({ status: "missing" });

    host.focus("first-window");
    expect(host.active().bindings.map((row) => row.commandId)).toEqual([
      "first-window:new",
    ]);
    await expect(
      host.execute("first-window:new", { origin: "palette" }),
    ).resolves.toMatchObject({ status: "handled", result: "first:new" });
    expect(firstInvoke).toHaveBeenCalledTimes(1);

    first.dispose();
    expect(host.active().slash).toEqual([]);
    second.dispose();
    host.dispose();
  });

  it("replaces one mount generation and disposes it without affecting another mount", async () => {
    const host = createAppSurfaceCommandHost(createWhistle());
    const firstInvoke = vi.fn<Invoke>((id) => Promise.resolve(id));
    const secondInvoke = vi.fn<Invoke>((id) => Promise.resolve(id));
    const firstMount = host.mount(
      "first",
      declarations(command("old"), command("replacement"), command("latest")),
    );
    const firstContribution = await firstMount.handlers.registerCommands({
      commands: [command("old")],
      invoke: firstInvoke,
    });
    const secondMount = host.mount("second", [command("other")]);
    await secondMount.handlers.registerCommands({
      commands: [command("other")],
      invoke: secondInvoke,
    });

    host.focus("first");
    expect(host.menu().map((row) => row.commandId)).toEqual(["first:old"]);
    firstContribution.update([command("replacement")]);
    expect(host.menu().map((row) => row.commandId)).toEqual([
      "first:replacement",
    ]);
    await expect(
      host.execute("first:old", { origin: "menu" }),
    ).resolves.toEqual({ status: "missing" });

    firstMount.dispose();
    expect(host.menu()).toEqual([]);
    host.focus("second");
    expect(host.menu().map((row) => row.commandId)).toEqual(["second:other"]);
    host.dispose();
    expect(host.snapshot().menu).toEqual([]);
    secondMount.dispose();
  });

  it("notifies for focus and graph changes, then detaches from Whistle on disposal", async () => {
    const whistle = createWhistle();
    const runtimeUnsubscribe = vi.fn();
    const runtime: WhistleRuntime = {
      ...whistle,
      subscribe: (listener) => {
        const unsubscribe = whistle.subscribe(listener);
        return () => {
          runtimeUnsubscribe();
          unsubscribe();
        };
      },
    };
    const host = createAppSurfaceCommandHost(runtime);
    const mount = host.mount(
      "first",
      declarations(command("old"), command("new"), command("latest")),
    );
    const contribution = await mount.handlers.registerCommands({
      commands: [command("old")],
      invoke: vi.fn<Invoke>((id) => Promise.resolve(id)),
    });
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);

    host.focus("first");
    host.focus("first");
    expect(listener).toHaveBeenCalledTimes(1);

    host.focus("missing");
    expect(host.menu()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);

    contribution.update([command("new")]);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    host.focus("first");
    contribution.update([command("latest")]);
    expect(listener).toHaveBeenCalledTimes(3);

    host.dispose();
    host.dispose();
    expect(runtimeUnsubscribe).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it("registers the shell's commands and forwards the reserved leader chord", async () => {
    const host = createAppSurfaceCommandHost();
    const openApp = vi.fn();
    const showKeys = vi.fn();
    const disposeShell = host.registerShellCommands([
      {
        id: "open-app",
        title: "Open App",
        category: "Apps",
        projections: { palette: {}, bindings: { values: ["<leader> o"] } },
        handler: openApp,
      },
      {
        id: "show-command-palette",
        title: "Show keys",
        category: "System",
        projections: { bindings: { values: ["super+k"] } },
        handler: showKeys,
      },
    ]);
    try {
      expect(host.active().palette.map((row) => row.commandId)).toEqual([
        "shell:open-app",
      ]);
      await expect(
        host.execute("shell:open-app", { origin: "keyboard" }),
      ).resolves.toMatchObject({ status: "handled" });
      const appMount = host.mount("focused-app", [
        {
          id: "steal",
          title: "Steal",
          category: "App",
          projections: { bindings: { values: ["super+k"] } },
        },
      ]);
      await appMount.handlers.invokeReservedChord({
        id: "shell:show-command-palette",
        repeat: false,
      });
      await appMount.handlers.invokeReservedChord({
        id: "shell:show-command-palette",
        repeat: true,
      });
      await expect(
        appMount.handlers.invokeReservedChord({ id: "other", repeat: false }),
      ).rejects.toThrow("unavailable");
      await expect(
        appMount.handlers.registerCommands({
          commands: [
            {
              id: "steal",
              title: "Steal",
              category: "App",
              projections: { bindings: { values: ["super+k"] } },
            },
          ],
          invoke: () => Promise.resolve(undefined),
        }),
      ).rejects.toThrow("reserved leader chord");
      for (const reservedBinding of ["ctrl+k", "control+k"]) {
        const declaration = {
          id: `steal-${reservedBinding}`,
          title: "Steal",
          category: "App",
          projections: { bindings: { values: [reservedBinding] } },
        };
        const conflictingMount = host.mount(`conflicting-${reservedBinding}`, [
          declaration,
        ]);
        try {
          await expect(
            conflictingMount.handlers.registerCommands({
              commands: [declaration],
              invoke: () => Promise.resolve(undefined),
            }),
          ).rejects.toThrow("reserved leader chord");
        } finally {
          conflictingMount.dispose();
        }
      }
      appMount.dispose();
      expect(openApp).toHaveBeenCalledOnce();
      expect(showKeys).toHaveBeenCalledOnce();
      expect(
        await host.execute("shell:open-other-app", { origin: "browser" }),
      ).toEqual({ status: "missing" });
    } finally {
      disposeShell();
      expect(
        host
          .snapshot()
          .palette.some((row) => row.commandId.startsWith("shell:")),
      ).toBe(false);
      host.dispose();
    }
  });
});

it("a pane admits only its own snapshot under human, programmatic and agent origins", async () => {
  const host = createAppSurfaceCommandHost();
  const first = host.mountPane("a");
  const second = host.mountPane("b");
  const own = vi.fn(() => "own");
  const foreign = vi.fn(() => "foreign");
  const row = (handler: () => string) => [
    { ...command("run"), projections: { menu: {}, agent: {} }, handler },
  ];
  first.contribute(row(own));
  second.contribute(row(foreign));
  host.registerShellCommands([
    {
      ...command("global"),
      projections: { menu: {}, agent: {} },
      handler: () => "global",
    },
  ]);
  const ownId = first
    .snapshot()
    .agent.find((item) => item.scope === "a")?.commandId;
  const foreignId = second
    .snapshot()
    .agent.find((item) => item.scope === "b")?.commandId;
  const globalId = first
    .snapshot()
    .agent.find((item) => item.scope === undefined)?.commandId;
  if (ownId === undefined || foreignId === undefined || globalId === undefined)
    throw new Error("Missing fixture commands");
  try {
    expect(first.snapshot().agent.map((item) => item.commandId)).not.toContain(
      foreignId,
    );
    for (const focus of ["a", "b"]) {
      host.focus(focus);
      for (const origin of ["menu", "programmatic", "agent"] as const)
        expect(await first.execute(foreignId, { origin })).toEqual({
          status: "missing",
        });
    }
    expect(await first.execute(ownId, { origin: "menu" })).toEqual({
      status: "missing",
    });
    expect(await first.execute(globalId, { origin: "menu" })).toEqual({
      status: "missing",
    });
    for (const origin of ["programmatic", "agent"] as const) {
      expect(await first.execute(ownId, { origin })).toMatchObject({
        status: "handled",
        result: "own",
      });
      expect(await first.execute(globalId, { origin })).toMatchObject({
        status: "handled",
        result: "global",
      });
    }
    host.focus("a");
    expect(await first.execute(ownId, { origin: "menu" })).toMatchObject({
      status: "handled",
    });
    expect(await first.execute(globalId, { origin: "menu" })).toMatchObject({
      status: "handled",
      result: "global",
    });
    expect(foreign).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledTimes(3);
  } finally {
    host.dispose();
  }
});

it("disposing the focused pane clears focus before its identity can be reused", async () => {
  const host = createAppSurfaceCommandHost();
  const pane = host.mountPane("same");
  pane.contribute([{ ...command("old"), handler: () => undefined }]);
  host.focus("same");
  pane.dispose();
  const replacement = host.mountPane("same");
  replacement.contribute([{ ...command("new"), handler: () => "new" }]);
  const id = replacement
    .snapshot()
    .menu.find((row) => row.title === "new")?.commandId;
  if (id === undefined) throw new Error("Missing replacement command");
  try {
    expect(host.active().menu).toEqual([]);
    expect(await replacement.execute(id, { origin: "menu" })).toEqual({
      status: "missing",
    });
    host.focus("same");
    expect(await replacement.execute(id, { origin: "menu" })).toMatchObject({
      status: "handled",
      result: "new",
    });
  } finally {
    host.dispose();
  }
});
