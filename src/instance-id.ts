import { defineIdFamily, type CairnId } from "@fungi.computer/cairn/id";
import * as Schema from "effect/Schema";

/** The Cairn ID family that mints and recognizes App Instance IDs (`instance_…`). */
export const instanceIds = defineIdFamily({
  family: "app-instance",
  version: 1,
  kinds: { instance: { prefix: "instance" } },
});
/** A stable App Instance ID minted by {@link instanceIds}. */
export type InstanceId = CairnId<"app-instance", "instance">;
/** Decodes a string into an {@link InstanceId}, rejecting any other ID family. */
export const instanceIdSchema: Schema.Codec<InstanceId, string> =
  Schema.String.pipe(
    Schema.refine((value): value is InstanceId =>
      instanceIds.instance.is(value),
    ),
  );
