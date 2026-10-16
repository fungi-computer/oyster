import type { AppOpenRequest } from "@fungi.computer/agar";

/**
 * A window's current launch target: the open request and Computer its child
 * App should see. `reconfigure` moves this forward as the window is handed a
 * new file; a later restore (`setVisibility`) must read the latest target
 * here, never the window's first open request.
 */
export type WindowLaunchTarget = Readonly<{
  openRequest: AppOpenRequest | null;
  computerId: string | null;
}>;

export type WindowLaunchTracker = Readonly<{
  current: () => WindowLaunchTarget;
  advance: (next: WindowLaunchTarget) => void;
}>;

/** One window's launch history: starts at its first open, moves forward on
 * every `reconfigure`, and never resets on its own. */
export function createWindowLaunchTracker(
  initial: WindowLaunchTarget,
): WindowLaunchTracker {
  let current = initial;
  return {
    current: () => current,
    advance: (next) => {
      current = next;
    },
  };
}
