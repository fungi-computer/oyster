import { defineIdFamily } from "@fungi.computer/cairn/id";

/** Server- and widget-minted channel identities, shared by both Oyster hosts. */
export const channelIds = defineIdFamily({
  family: "channel",
  version: 1,
  kinds: {
    binding: { prefix: "chb" },
    site: { prefix: "site_pk" },
    /** The public, unguessable address of one incoming-events binding. */
    endpoint: { prefix: "evt_ep" },
    visitor: { prefix: "v" },
    /** One visitor message; the widget mints it so a resend replays. */
    message: { prefix: "msg" },
  },
});
