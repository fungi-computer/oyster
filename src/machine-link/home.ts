import * as Schema from "effect/Schema";

// The directory's opaque identities use the same bound as Agent mail addresses.
const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/**
 * A Team Agent's delivery home, not a second Agent or relationship identity.
 * Routing needs only the device; the attaching member stays with the
 * enrollment owner, which reauthorizes it for every act.
 */
const machineAgentHomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("hosted") }),
  Schema.Struct({
    kind: Schema.Literal("machine"),
    deviceId: identifier,
  }),
]);

/** The home published by a trusted Team directory projection. */
export type MachineAgentHome = typeof machineAgentHomeSchema.Type;

/**
 * Decode one home without silently accepting another routing representation.
 * This validates shape only; the host must attest the device.
 */
export function decodeMachineAgentHome(input: unknown): MachineAgentHome {
  return Schema.decodeUnknownSync(machineAgentHomeSchema, {
    onExcessProperty: "error",
  })(input);
}
