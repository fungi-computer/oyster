import { DurableObject } from "cloudflare:workers";

/**
 * Every class bound to an old DO name uses this constructor, not the published
 * host constructor: the latter can create tables or start background work.
 */
export class ReadOnlyOldOysterDO extends DurableObject {
  // Do not run old work, re-arm, delete, or write a receipt on native delivery.
  alarm(): Promise<void> {
    return Promise.resolve();
  }

  /** Capture the alarm as observed when this DO is read, never at construction. */
  readPendingAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

export class OysterArchivingError extends Error {
  readonly code = "oyster_archiving";

  constructor() {
    super("Oyster is archiving");
    this.name = "OysterArchivingError";
  }
}
