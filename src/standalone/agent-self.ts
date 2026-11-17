import { Mycelium, type CapabilitySource } from "@fungi.computer/mycelium";
import { z } from "zod";
import { agentAvatarSchema } from "../agent-avatars.js";
import type { AgentEntry } from "./agents.js";
import type { TenantPrincipal } from "../tenant.js";
import type { Avatar } from "@fungi.computer/sprite/avatar";

const refusal = z.strictObject({
  error: z.enum(["name_taken", "not_found", "not_granted"]),
});

/** Expected refusals from the standalone identity owner. */
export type SelfIdentityRefusal = Readonly<{
  error: "name_taken" | "not_found" | "not_granted";
}>;

/** The pinned directory's identity commands, called only as this Agent. */
export type SelfIdentityDirectory = Readonly<{
  rename: (
    agentId: string,
    name: string,
    principal: TenantPrincipal,
  ) =>
    | AgentEntry
    | SelfIdentityRefusal
    | Promise<AgentEntry | SelfIdentityRefusal>;
  setAvatar: (
    agentId: string,
    avatar: Avatar,
    principal: TenantPrincipal,
  ) =>
    | AgentEntry
    | SelfIdentityRefusal
    | Promise<AgentEntry | SelfIdentityRefusal>;
}>;

/** Standalone identity tools are bound to the host Agent, never a supplied target. */
export function createSelfSource(
  port: Readonly<{
    agentId: string;
    directory: () => Promise<SelfIdentityDirectory>;
    isChannelSession: (sessionId: string) => boolean;
  }>,
): CapabilitySource {
  const principal = {
    actor: { kind: "agent", agentId: port.agentId },
  } as const;
  return {
    id: "oyster-agent-self",
    acquire: ({ signal, session }) => {
      signal.throwIfAborted();
      const present =
        session !== undefined && !port.isChannelSession(session.sessionId);
      return Promise.resolve({
        snapshot: {
          version: present ? "oyster-agent-self-v1" : "0",
          modules: present
            ? [
                Mycelium.module({
                  id: "oyster-agent-self",
                  name: "self",
                  description: "Change your own Agent name and avatar.",
                  operations: {
                    rename: Mycelium.operation({
                      // Repeating the current value is a no-op, not permission to replay old values.
                      replay: "unsafe",
                      description:
                        "Rename yourself. A name held by another Agent is refused.",
                      input: z.strictObject({
                        name: z.string().trim().min(1).max(256),
                      }),
                      output: z.union([
                        z.strictObject({
                          name: z.string(),
                          avatar: agentAvatarSchema,
                        }),
                        refusal,
                      ]),
                      execute: async ({ name }) => {
                        const result = await (
                          await port.directory()
                        ).rename(port.agentId, name, principal);
                        return "error" in result
                          ? result
                          : { name: result.name, avatar: result.avatar };
                      },
                    }),
                    setAvatar: Mycelium.operation({
                      replay: "unsafe",
                      description:
                        "Change your own avatar using the existing Avatar grammar.",
                      input: z.strictObject({ avatar: agentAvatarSchema }),
                      output: z.union([
                        z.strictObject({ avatar: agentAvatarSchema }),
                        refusal,
                      ]),
                      execute: async ({ avatar }) => {
                        const result = await (
                          await port.directory()
                        ).setAvatar(port.agentId, avatar, principal);
                        return "error" in result
                          ? result
                          : { avatar: result.avatar };
                      },
                    }),
                  },
                }),
              ]
            : [],
        },
        release: () => Promise.resolve(),
      });
    },
  };
}
