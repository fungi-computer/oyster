/** Shared stream caps, independent of the host's Session watch and SSE pump. */
export function createVisitorStreamSlots() {
  const visitors = new Map<string, number>();
  const bindings = new Map<string, number>();
  const addresses = new Map<string, number>();
  return (
    bindingId: string,
    visitorId: string,
    addressHash: string,
  ): (() => void) | null => {
    const address = bindingId + ":" + addressHash;
    if (
      (visitors.get(visitorId) ?? 0) >= 2 ||
      (bindings.get(bindingId) ?? 0) >= 32 ||
      (addresses.get(address) ?? 0) >= 8
    )
      return null;
    const entries: readonly [Map<string, number>, string][] = [
      [visitors, visitorId],
      [bindings, bindingId],
      [addresses, address],
    ];
    for (const [counts, key] of entries)
      counts.set(key, (counts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [counts, key] of entries) {
        const remaining = (counts.get(key) ?? 1) - 1;
        if (remaining === 0) counts.delete(key);
        else counts.set(key, remaining);
      }
    };
  };
}
