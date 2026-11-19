import { DurableObject } from "cloudflare:workers";

/** The owner's SQLite, the shape a Connections owner is given on Cloudflare. */
export class ConnectionsOwner extends DurableObject {}

export default {
  fetch: () => new Response("probe"),
};
