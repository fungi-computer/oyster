import * as z from "zod/mini";
import type { AppInstanceErrorCode } from "./index.js";

/** Private RPC envelope. Domain results, including domain refusals, stay inside value. */
export type FrameBindingReply<Value> =
  | Readonly<{ kind: "result"; value: Value }>
  | Readonly<{ kind: "local_refusal"; code: AppInstanceErrorCode }>;

/** Native entrypoint methods carry the envelope; guest interfaces are restored by wrap. */
export type FrameBindingWire<Methods> = {
  [Name in keyof Methods]: Methods[Name] extends (
    ...args: infer Args
  ) => Promise<infer Value>
    ? (...args: Args) => Promise<FrameBindingReply<Value>>
    : never;
};

const frameStubsSchema = z.lazy(() =>
  z.record(z.string(), z.instanceof(Object)),
);
type FrameBindingStubs = z.output<typeof frameStubsSchema>;

/** The host supplies its one closed refusal vocabulary to both copies of this decoder. */
export function createFrameBindingWire<
  const Codes extends readonly [string, ...string[]],
>(codes: Codes) {
  const replySchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), value: z.unknown() }),
    z.strictObject({ kind: z.literal("local_refusal"), code: z.enum(codes) }),
  ]);
  class LocalRefusal extends Error {
    override readonly name = "AppInstanceError";
    constructor(readonly code: string) {
      super(`App binding refused: ${code}`);
    }
  }
  const decode = (raw: unknown) => replySchema.parse(raw);
  const unwrap = (raw: unknown) => {
    const reply = replySchema.parse(raw);
    if (reply.kind === "local_refusal") throw new LocalRefusal(reply.code);
    return reply.value;
  };
  return {
    decode,
    wrap(bindings: FrameBindingStubs): object {
      return Object.fromEntries(
        Object.entries(frameStubsSchema.parse(bindings)).map(([name, stub]) => {
          return [
            name,
            new Proxy(
              {},
              {
                get(_target, method) {
                  const named = z.string().safeParse(method);
                  if (!named.success || named.data === "then") return undefined;
                  return async (...args: readonly unknown[]) => {
                    const callSchema = z.function({
                      input: z.array(z.unknown()),
                      output: z.promise(z.unknown()),
                    });
                    // Native RPC methods are selectable without reflected key membership.
                    // A plain lookup view also accepts callable native namespaces. The selected
                    // callable is still required before invoking it with the native receiver.
                    const call = z
                      .object({ [named.data]: z.optional(callSchema) })
                      .parse(Object.create(stub))[named.data];
                    if (call === undefined)
                      throw new Error("App binding method unavailable");
                    return unwrap(await call.apply(stub, [...args]));
                  };
                },
              },
            ),
          ];
        }),
      );
    },
  };
}
