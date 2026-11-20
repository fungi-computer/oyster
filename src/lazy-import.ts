/**
 * Load a module on first use. A failed load (a missing chunk, a corrupt
 * bundle) is reported as the feature that could not start, with the loader's
 * own error as the cause, instead of a bare module-resolution message.
 */
export async function loadLazily<Loaded>(
  load: () => Promise<Loaded>,
  what: string,
): Promise<Loaded> {
  try {
    return await load();
  } catch (cause) {
    throw new Error(`${what} failed to load`, { cause });
  }
}
