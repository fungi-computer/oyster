import type { AppStorage } from "@fungi.computer/agar/storage";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import * as z from "zod";
import type { TeamWorkbenchHostHandle } from "./workbench-contract.js";

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

/** The module namespace a shell Release must export; built on first use,
 * since only a browser has `HTMLElement`. */
const shellModuleSchema = () =>
  z.object({
    mountShell: z.function({
      // The host supplies the input itself; the shell parses its own handles.
      input: [z.instanceof(HTMLElement), z.unknown()],
      output: z.promise(z.function({ input: [], output: z.void() })),
    }),
  });

/** The picked shell's module could not be loaded or does not fit the contract. */
export class ShellModuleError extends Error {
  override readonly name = "ShellModuleError";
}

/**
 * Import the picked shell Release's module from the host's own origin and
 * check that it exports `mountShell`. The host never bundles a shell.
 */
export async function importShellModule(
  moduleUrl: URL,
  hostOrigin: string,
): Promise<MountShell> {
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
  return decoded.data.mountShell;
}
