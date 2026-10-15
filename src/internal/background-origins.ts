import { admitMethodMetadata, type GateFacts } from "../apps/gate.js";

/** Project only write origins admitted by this frame's fresh canonical gate. */
export function admittedBackgroundOrigins(gate: GateFacts): readonly string[] {
  return Object.entries(gate.api?.methods ?? {})
    .filter(
      ([name, method]) =>
        method.effect === "write" &&
        admitMethodMetadata(gate, name).kind === "admitted",
    )
    .map(([name]) => name);
}
