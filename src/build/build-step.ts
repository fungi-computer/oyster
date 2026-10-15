import * as Schema from "effect/Schema";

/**
 * One captured dependency build step. Paths are relative to the captured
 * snapshot root. A TypeScript step compiles one config; a Tailwind step
 * compiles one stylesheet input into its output (the same path for an App's
 * own stylesheet, which compiles in place).
 */
export const workspaceBuildStepSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("typescript"),
    config: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("tailwind"),
    input: Schema.String,
    output: Schema.String,
  }),
]);

/** One captured dependency build step. */
export type WorkspaceBuildStep = Schema.Schema.Type<
  typeof workspaceBuildStepSchema
>;

/** The steps one dependency-build process runs, encoded as one argument. */
export const workspaceBuildStepsJsonSchema = Schema.fromJsonString(
  Schema.Array(workspaceBuildStepSchema),
);
