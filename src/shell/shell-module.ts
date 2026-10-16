import type { AppStorage } from "@fungi.computer/agar/storage";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import * as z from "zod";
import type { TeamWorkbenchHostHandle } from "./workbench-contract.js";
import type { WorkbenchHostControls } from "./workbench-host-types.js";

/**
 * What a host hands the shell a Team picked. The host composes that shell into
 * its own top-level document, so it runs with the host's escalated
 * permissions: the workbench mounts each child App in its sandboxed frame, and
 * `storage`/`methods` are the shell installation's own desktop data.
 */
export type ShellMountInput = Readonly<{
  workbench: TeamWorkbenchHostHandle;
  storage: AppStorage;
  methods: Readonly<{
    /** Call one of the shell installation's declared backend methods. */
    call(method: string, input: string): Promise<WhistleJsonValue>;
  }>;
}>;

/**
 * Render the shell into `root`; resolves once it is mounted, with the
 * function that removes it again. The shell loads its own code and styles.
 */
export type MountShell = (
  root: HTMLElement,
  input: ShellMountInput,
) => Promise<() => void>;

/**
 * Settings a shell renders for a host that has none of its own, such as a
 * standalone Oyster: the shell draws them into `root`, and the host hands
 * `controls` to its workbench so Apps and the dashboard can open them.
 */
export type ShellPlatformControls = Readonly<{
  controls: WorkbenchHostControls;
  /** A child App suggested desktop Settings for one of its surfaces. */
  suggestDesktopSettings(surfaceId: string): void;
  /** Remove the rendered Settings. */
  dispose(): void;
}>;

/** Render the shell's own Settings into `root` for the host at `teamId`. */
export type MountPlatformControls = (
  root: HTMLElement,
  input: Readonly<{ teamId: string }>,
) => Promise<ShellPlatformControls>;

/** What a host gets from a picked shell Release's module. */
export type ShellModule = Readonly<{
  mountShell: MountShell;
  /** Absent when the shell renders no Settings of its own. */
  mountPlatformControls: MountPlatformControls | null;
}>;

const unsubscribe = () => z.function({ input: [], output: z.void() });
/** The module namespace a shell Release must export; built on first use,
 * since only a browser has `HTMLElement`. */
const shellModuleSchema = () =>
  z.object({
    mountShell: z.function({
      // The host supplies the input itself; the shell parses its own handles.
      input: [z.instanceof(HTMLElement), z.unknown()],
      output: z.promise(z.function({ input: [], output: z.void() })),
    }),
    mountPlatformControls: z
      .function({
        input: [
          z.instanceof(HTMLElement),
          z.object({ teamId: z.string() }).readonly(),
        ],
        output: z.promise(
          z.object({
            controls: z.object({
              sections: z.array(z.string()).readonly().optional(),
              // The host passes the workbench's own values; the shell
              // parses what it reads.
              parseSettings: z.function({
                input: [z.unknown()],
                output: z.json(),
              }),
              openSettings: z.function({
                input: [z.unknown(), z.object({ restoreFocus: z.boolean() })],
                output: z.void(),
              }),
              subscribeSettingsClosed: z.function({
                input: [unsubscribe()],
                output: unsubscribe(),
              }),
              subscribeChanges: z.function({
                input: [unsubscribe()],
                output: unsubscribe(),
              }),
              attachDesktopSettings: z.function({
                input: [z.unknown()],
                output: unsubscribe(),
              }),
              requestAppAccess: z.function({
                input: [z.unknown(), z.unknown()],
                output: z.promise(z.enum(["granted", "declined", "customize"])),
              }),
            }),
            suggestDesktopSettings: z.function({
              input: [z.string()],
              output: z.void(),
            }),
            dispose: unsubscribe(),
          }),
        ),
      })
      .optional(),
  });

/** The picked shell's module could not be loaded or does not fit the contract. */
export class ShellModuleError extends Error {
  override readonly name = "ShellModuleError";
}

/**
 * Import the picked shell Release's module from the host's own origin and
 * check that it exports `mountShell`, and `mountPlatformControls` when it
 * offers its own Settings. The host never bundles a shell.
 */
export async function importShellModule(
  moduleUrl: URL,
  hostOrigin: string,
): Promise<ShellModule> {
  if (moduleUrl.origin !== hostOrigin || moduleUrl.hash !== "")
    throw new ShellModuleError("The shell module must come from this host");
  let namespace: unknown;
  try {
    namespace = await import(/* @vite-ignore */ moduleUrl.href);
  } catch (cause) {
    throw new ShellModuleError("The picked shell could not be loaded", {
      cause,
    });
  }
  const decoded = shellModuleSchema().safeParse(namespace);
  if (!decoded.success)
    throw new ShellModuleError("The picked shell does not export mountShell", {
      cause: decoded.error,
    });
  return {
    mountShell: decoded.data.mountShell,
    mountPlatformControls: decoded.data.mountPlatformControls ?? null,
  };
}
