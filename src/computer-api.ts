import * as Schema from "effect/Schema";
import * as z from "zod";
import {
  maximumCommandCharacters,
  maximumFileBytes,
  maximumListEntries,
  maximumProcessLogLines,
  genericComputerExecutionBudget,
  computerOperationResultSchema,
  computerProcessSchema,
  processLogsOutputSchema,
  processKillOutputSchema,
  readOutputSchema,
  writeOutputSchema,
  listOutputSchema,
  removeOutputSchema,
  computerPortOutputSchema,
} from "@fungi.computer/computer-contract";

const text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
/** A `..` segment: paths stay whole-machine for the owner, but never ambiguous. */
export const computerApiDotSegment = /(?:^|\/)\.\.(?:\/|$)/u;
const path = text(4096).check(
  Schema.isPattern(/^(?!.*(?:^|\/)\.\.(?:\/|$))\/[^\0]*$/u),
);
const command = {
  command: text(maximumCommandCharacters),
  cwd: Schema.optionalKey(path),
};
/** HTTP envelopes are bounded before JSON parsing, including escaped file text. */
export const computerApiBodyBytes = maximumFileBytes * 6 + 8192;
/** The inventory identity is independent of the currently selected UI Computer. */
export const computerApiId = text(256);
/** These schemas own the public wire grammar; OpenAPI is projected from them. */
export const computerApiInputs = {
  exec: Schema.Struct({
    ...command,
    requestId: Schema.String.check(Schema.isUUID(7)),
    timeoutMs: Schema.optionalKey(
      integer(1, genericComputerExecutionBudget.maximumTimeMs),
    ),
  }),
  start: Schema.Struct({ ...command, requestId: text(256) }),
  logs: Schema.Struct({
    id: text(256),
    lines: Schema.optionalKey(integer(1, maximumProcessLogLines)),
  }),
  kill: Schema.Struct({ id: text(256) }),
  read: Schema.Struct({ path }),
  write: Schema.Struct({
    path,
    content: Schema.String.check(Schema.isMaxLength(maximumFileBytes)),
  }),
  list: Schema.Struct({
    path: Schema.optionalKey(path),
    limit: Schema.optionalKey(integer(1, maximumListEntries)),
    offset: Schema.optionalKey(integer(0, Number.MAX_SAFE_INTEGER)),
  }),
  remove: Schema.Struct({ path }),
  expose: Schema.Struct({ port: integer(1, 65535) }),
};
/** The native owner receives a closed, typed operation, never an arbitrary method name. */
export const computerApiRequestSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("exec"),
    input: computerApiInputs.exec,
  }),
  Schema.Struct({
    operation: Schema.Literal("start"),
    input: computerApiInputs.start,
  }),
  Schema.Struct({
    operation: Schema.Literal("logs"),
    input: computerApiInputs.logs,
  }),
  Schema.Struct({
    operation: Schema.Literal("kill"),
    input: computerApiInputs.kill,
  }),
  Schema.Struct({
    operation: Schema.Literal("read"),
    input: computerApiInputs.read,
  }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    input: computerApiInputs.write,
  }),
  Schema.Struct({
    operation: Schema.Literal("list"),
    input: computerApiInputs.list,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    input: computerApiInputs.remove,
  }),
  Schema.Struct({
    operation: Schema.Literal("expose"),
    input: computerApiInputs.expose,
  }),
]);
/** A decoded REST operation, with no caller-supplied authority. */
export type ComputerApiRequest = typeof computerApiRequestSchema.Type;
/** Shared REST operations for Oyster and the Team Computers OpenAPI document. */
export const computerApiOperations = [
  {
    operation: "exec",
    method: "post",
    path: "/exec",
    action: "exec",
    output: computerOperationResultSchema,
  },
  {
    operation: "start",
    method: "post",
    path: "/processes/start",
    action: "processStart",
    output: computerProcessSchema,
  },
  {
    operation: "logs",
    method: "get",
    path: "/processes/logs",
    action: "processLogs",
    output: processLogsOutputSchema,
  },
  {
    operation: "kill",
    method: "post",
    path: "/processes/kill",
    action: "processKill",
    output: processKillOutputSchema,
  },
  {
    operation: "read",
    method: "get",
    path: "/files",
    action: "files.read",
    output: readOutputSchema,
  },
  {
    operation: "write",
    method: "put",
    path: "/files",
    action: "files.write",
    output: writeOutputSchema,
  },
  {
    operation: "list",
    method: "get",
    path: "/files/list",
    action: "files.list",
    output: listOutputSchema,
  },
  {
    operation: "remove",
    method: "delete",
    path: "/files",
    action: "files.remove",
    output: removeOutputSchema,
  },
  {
    operation: "expose",
    method: "post",
    path: "/ports",
    action: "exposePort",
    output: computerPortOutputSchema,
  },
] as const;

/** Project the same runtime request schema into the existing OpenAPI registry. */
export function computerApiInputDocument(
  operation: ComputerApiRequest["operation"],
) {
  return Schema.toJsonSchemaDocument(computerApiInputs[operation], {
    onExcessProperty: "error",
  }).schema;
}
/** Native Computer contracts continue to own their bounded response shapes. */
export function computerApiOutputDocument(
  operation: (typeof computerApiOperations)[number],
) {
  return z.toJSONSchema(operation.output);
}
