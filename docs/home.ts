import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AppInstanceError,
  createAppInstance,
  instanceIds,
  ownerStateSchema,
  type Instance,
} from "@fungi.computer/oyster";
import {
  APP_INVOCATION_CEILING_MS,
  createInvocationGate,
  invocationFactsSchema,
} from "@fungi.computer/oyster/invocation";

const instanceId = instanceIds.instance.generate();
let stored: Instance | null = null;
const instance = createAppInstance({
  instanceId,
  read: () => Effect.succeed(stored),
  write: (record) =>
    Effect.sync(() => {
      stored = record;
    }),
  resolve: () => Effect.fail(new Error("No Releases in this example")),
  abort: () => Effect.void,
  purge: () => Effect.void,
  connect: () => Effect.fail(new Error("No backend in this example")),
});

const selection = {
  instanceId,
  owner: { kind: "installation", id: "installation_example" },
  appId: "app_example",
  releaseId: "rel_example",
  authorityVersion: 2,
} as const;
const disabled = Schema.decodeUnknownSync(ownerStateSchema)({
  ...selection,
  status: "disabled",
});

const receipt = await Effect.runPromise(instance.apply(disabled));
console.log(receipt.status); // "disabled"

// A request runs inside an invocation frame: the caller facts the host admitted,
// a deadline, and an abort signal the gate owns.
const gate = createInvocationGate<null>({
  abortGuest: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
const facts = Schema.decodeUnknownSync(invocationFactsSchema)({
  instanceId,
  selection,
  artifactDigest: `sha256:${"0".repeat(64)}`,
  subject: {
    kind: "call",
    context: {
      actor: { kind: "member", memberId: "member_example" },
      computerId: null,
    },
  },
  grants: [],
  ancestry: [],
  deadlineAt: Date.now() + APP_INVOCATION_CEILING_MS,
});
const refused = await gate.run(facts, null, (frame) =>
  Effect.runPromise(
    Effect.result(instance.fetch(frame, new Request("https://app.test/"))),
  ),
);
if (refused._tag === "Failure" && refused.failure instanceof AppInstanceError)
  console.log(refused.failure.code); // "instance_inactive"
