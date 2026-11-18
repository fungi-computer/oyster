import { once } from "node:events";
import { access } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Message, sessionBus } from "@jellybrick/dbus-next";
import * as z from "zod";

const secretServiceName = "org.freedesktop.secrets";
const missingBus = z.object({ code: z.enum(["ENOENT", "ECONNREFUSED"]) });

/** No address, X11 display or XDG bus socket: no session bus can be reached. */
async function noSessionBusAddress(): Promise<boolean> {
  if (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY) return false;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) return true;
  try {
    await access(join(runtime, "bus"));
    return false;
  } catch (cause) {
    if (missingBus.safeParse(cause).success) return true;
    throw cause;
  }
}

/**
 * Whether this Linux session is known to have no Secret Service: no session
 * bus, or a bus that neither runs nor can activate `org.freedesktop.secrets`.
 * The keyring binding reports an absent and a broken service alike as
 * GenericFailure, so ask the bus for its typed name lists instead of reading
 * error text. A present but locked or failing service is not absent; its
 * errors stay fatal so private custody never silently downgrades to a file.
 */
export async function secretServiceAbsent(): Promise<boolean> {
  if (await noSessionBusAddress()) return true;
  let bus: ReturnType<typeof sessionBus> | undefined;
  try {
    bus = sessionBus();
    const connected = bus;
    const names = async (member: "ListNames" | "ListActivatableNames") => {
      const reply = await Promise.race([
        connected.call(
          new Message({
            destination: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            interface: "org.freedesktop.DBus",
            member,
          }),
        ),
        once(connected, "error", { signal: AbortSignal.timeout(3_000) }),
      ]);
      if (Array.isArray(reply)) {
        const error: unknown = reply[0];
        if (error instanceof Error) throw error;
        throw new Error("Cannot connect to the Secret Service session bus");
      }
      if (reply === null)
        throw new Error("Cannot inspect the Secret Service session bus");
      return z.array(z.string()).parse(reply.body[0]);
    };
    const [active, activatable] = await Promise.all([
      names("ListNames"),
      names("ListActivatableNames"),
    ]);
    return (
      !active.includes(secretServiceName) &&
      !activatable.includes(secretServiceName)
    );
  } catch (cause) {
    // A stale address or socket path refuses the connection: no bus is running.
    if (missingBus.safeParse(cause).success) return true;
    throw cause;
  } finally {
    bus?.disconnect();
  }
}
