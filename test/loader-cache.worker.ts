import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import * as Schema from "effect/Schema";
import {
  artifactRefSchema,
  sha256DigestSchema,
  releaseSchema,
} from "@fungi.computer/puffball/effect";
import {
  createAppBuild,
  type AppDeclaration,
} from "@fungi.computer/puffball/app";
import {
  backendMediaType,
  type DurableBackend,
} from "@fungi.computer/puffball/backend";
import {
  OysterInstance,
  oysterBindings,
  type OysterBindingTable,
  type OysterWorkerEnv,
  type OysterInvocationHost,
} from "../dist/workers.js";
import {
  frameBindingEntrypoint,
  type FrameBindingProps,
} from "../dist/cloudflare.js";
import { type InvocationFrame } from "../dist/invocation.js";
import { instanceIds } from "../dist/index.js";
import { defaultTenant } from "../dist/tenant.js";
import { sha256 } from "../dist/release.js";
import { approvedInstallation } from "../dist/testing/installation.js";
export { OysterRegistry } from "../dist/workers.js";

export type Env = {
  INSTANCES: DurableObjectNamespace<LoaderProbe>;
} & OysterWorkerEnv;
const observation = z.strictObject({ actor: z.string(), frameId: z.string() });
const proofResult = z.union([
  observation.extend({
    moduleId: z.string(),
    moduleCalls: z.number(),
    denied: z.boolean(),
    deniedCode: z.string().nullable(),
  }),
  observation.extend({
    moduleId: z.string(),
    moduleCalls: z.number(),
    budgetWork: z.number(),
    budgetError: z.string().nullable(),
  }),
  z.strictObject({ error: z.string() }),
  z.strictObject({ proofError: z.string(), proofStack: z.string().optional() }),
]);
const methods = {
  INBOX: {
    page: {
      decodeArgs: (raw: readonly unknown[]) => z.tuple([]).parse(raw),
      decodeResult: (raw: unknown) => observation.parse(raw),
      requiredOperations: () => ["page"],
    },
    visit: {
      decodeArgs: (raw: readonly unknown[]) => z.tuple([z.string()]).parse(raw),
      decodeResult: (raw: unknown) => z.null().parse(raw),
      requiredOperations: () => ["visit"],
    },
  },
};
/** The probe root's one binding entrypoint; it can hold one late A packet. */
export const OysterBinding = frameBindingEntrypoint<Env, unknown>(
  methods,
  async (env, props, method, args) => {
    const probe = env.INSTANCES.getByName(props.instanceId);
    if (method === "visit" && args[0] === "A-packet") {
      await probe.holdPacket(props, method, args);
      return { kind: "result", value: null };
    }
    return probe.bindingCall(props, method, args);
  },
);
/** A local counted-fetch destination: no external network or provider authority. */
export class BudgetFetch extends WorkerEntrypoint {
  override fetch() {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
}
export class ProbeControl extends WorkerEntrypoint<
  Env,
  { instanceId: string }
> {
  async block(kind: "waitUntil" | "timer") {
    await this.env.INSTANCES.getByName(this.ctx.props.instanceId).block(kind);
    return { kind: "result", value: null };
  }
  async armed() {
    await this.env.INSTANCES.getByName(this.ctx.props.instanceId).armed();
    return { kind: "result", value: null };
  }
  async denied(label: string, message: string) {
    await this.env.INSTANCES.getByName(this.ctx.props.instanceId).denied(
      label,
      message,
    );
    return { kind: "result", value: null };
  }
  async release() {
    return this.env.INSTANCES.getByName(
      this.ctx.props.instanceId,
    ).releaseBarriers();
  }
}
const code = `import {DurableObject, env as loaded} from "cloudflare:workers";
let moduleId,calls=0,stash;
export class Guest extends DurableObject {
 async fetch(request) {
  moduleId??=crypto.randomUUID();
  const mode=new URL(request.url).searchParams.get("mode");
  if(mode.startsWith("budget-")) {
   let budgetWork=0,budgetError=null;
   for(let i=0;i<12;i++) {
    const response=await fetch("https://budget.invalid/");
    if(response.status!==204) throw new Error("Counted fetch sink failed");
    await response.arrayBuffer();
    budgetWork++;
   }
   if(mode.endsWith("exhaust")) {
    try {const response=await fetch("https://budget.invalid/");await response.arrayBuffer();budgetWork++;}
    catch(cause) {budgetError=cause.message;}
   }
   return Response.json({...await this.env.INBOX.page(),moduleId,moduleCalls:++calls,budgetWork,budgetError});
  }
  try {
  let denied=false,deniedCode=null;
  if(mode==="late") {
   stash=this.env.INBOX;
   this.ctx.waitUntil(stash.visit("A-packet").catch(cause=>loaded.CONTROL.denied("packet",cause.message)));
   this.ctx.waitUntil(loaded.CONTROL.block("waitUntil").then(()=>stash.visit("A-waitUntil")).catch(cause=>loaded.CONTROL.denied("waitUntil",cause.message)));
   await new Promise(resolve=>setTimeout(()=>{
    this.ctx.waitUntil(loaded.CONTROL.block("timer").then(()=>stash.visit("A-timer")).catch(cause=>loaded.CONTROL.denied("timer",cause.message)));resolve();
   },0));
   await loaded.CONTROL.armed();
  }
  if(mode==="wait") {
   // The control channel is not a frame binding, so its refusal reply arrives unwrapped.
   const released=await loaded.CONTROL.release(); if(released.kind==="local_refusal") deniedCode=released.code;
   try {await stash.visit("A-stash");} catch {denied=true;}
   await new Promise(resolve=>setTimeout(resolve,100));
   await this.env.INBOX.visit("B-control");
  }
  return Response.json({...await this.env.INBOX.page(),moduleId,moduleCalls:++calls,denied,deniedCode});
  } catch(cause) { return Response.json({proofError:cause.message,proofStack:cause.stack}); }
 }
}`;

// Only the provider observation and test barriers are supplied here. Admission,
// minting, Loader/facet execution, bindingCall and close use Oyster production code.
export class LoaderProbe extends OysterInstance<Env> {
  private readonly refusals: Record<string, string> = {};
  denied(label: string, message: string) {
    this.refusals[label] = message;
    return Promise.resolve();
  }
  private packet:
    | { props: FrameBindingProps; method: string; args: readonly unknown[] }
    | undefined;
  holdPacket(
    props: FrameBindingProps,
    method: string,
    args: readonly unknown[],
  ) {
    this.packet = { props, method, args };
    return this.block("packet");
  }
  private readonly effects: Record<string, number> = {};
  private readonly actors: Record<string, string> = {};
  private readonly blockers: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private armedSignal: (() => void) | undefined;
  protected override readonly bindings: OysterBindingTable<Env> = {
    ...oysterBindings,
    INBOX: {
      methods: methods.INBOX,
      dispatch: (_context, frame, _props, method, args) =>
        Promise.resolve(this.inbox(frame, method, args)),
    },
  };
  constructor(
    ctx: DurableObjectState & {
      exports: {
        OysterBinding(input: { props: FrameBindingProps }): object;
        BudgetFetch(options: Record<string, never>): Fetcher;
        ProbeControl(input: { props: { instanceId: string } }): object;
      };
    },
    env: Env,
  ) {
    // Only the fixture supplies an outbound destination, to exercise native
    // counted fetches, and a test-control channel in the loaded module's own
    // env. Production configures globalOutbound:null and an empty env.
    super(ctx, {
      ...env,
      LOADER: {
        get: (name, configure) =>
          env.LOADER.get(name, async () => ({
            ...(await configure()),
            env: {
              CONTROL: ctx.exports.ProbeControl({
                props: { instanceId: ctx.id.name ?? "" },
              }),
            },
            globalOutbound: ctx.exports.BudgetFetch({}),
          })),
        load: (configuration) =>
          env.LOADER.load({
            ...configuration,
            globalOutbound: ctx.exports.BudgetFetch({}),
          }),
      },
    });
  }
  private inbox(
    frame: InvocationFrame<OysterInvocationHost>,
    method: string,
    args: readonly unknown[],
  ) {
    if (
      frame.facts.subject.kind !== "call" ||
      frame.facts.subject.context.actor.kind !== "member"
    )
      throw new Error("Fixture actor required");
    const actor = frame.facts.subject.context.actor.memberId;
    if (method === "page") return { actor, frameId: frame.frameId };
    const [key] = z.tuple([z.string()]).parse(args);
    this.effects[key] = (this.effects[key] ?? 0) + 1;
    this.actors[key] = actor;
    return null;
  }
  block(kind: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Native ${kind} barrier timed out`));
      }, 10000);
      this.blockers.push({ resolve, timer });
      if (this.blockers.length === 3) this.armedSignal?.();
    });
  }
  armed() {
    if (this.blockers.length === 3) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.armedSignal = resolve;
    });
  }
  async releaseBarriers() {
    const packet = this.packet;
    this.packet = undefined;
    if (!packet) throw new Error("Native A packet not retained");
    const reply = await this.bindingCall(
      packet.props,
      packet.method,
      packet.args,
    );
    if (reply.kind === "local_refusal") this.refusals.packet = reply.code;
    for (const blocker of this.blockers.splice(0)) {
      clearTimeout(blocker.timer);
      blocker.resolve();
    }
    return reply;
  }
  async runProof(
    actor: string,
    mode: string,
    budget?: "subrequests",
  ): Promise<{
    status: number;
    result: z.infer<typeof proofResult>;
    effects: Record<string, number>;
    actors: Record<string, string>;
    packetRefusal: string | null;
  }> {
    const instanceId = this.ctx.id.name;
    if (instanceId === undefined || !instanceIds.instance.is(instanceId))
      throw new Error("Named Instance required");
    const persist = async (
      value: DurableBackend | ReturnType<typeof createAppBuild>,
    ) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const digest = Schema.decodeUnknownSync(sha256DigestSchema)(
        await sha256(bytes),
      );
      const artifactRef = Schema.decodeUnknownSync(artifactRefSchema)(
        `artifact:sha256-${digest.slice(7)}`,
      );
      await this.env.RELEASES.put(artifactRef, bytes);
      return { artifactRef, digest, byteLength: bytes.length, version: digest };
    };
    const backend = {
      ...(await persist({
        runtime: { kind: "durable-facet", stateSchema: 1 },
        compatibilityDate: "2026-09-04",
        exportName: "Guest",
        code,
      })),
      mediaType: backendMediaType,
    };
    const declaration: AppDeclaration = {
      capabilities: ["agent.read"],
      handlers: [],
      roles: [],
      backend: { bindings: [{ name: "INBOX", operations: ["page", "visit"] }] },
    };
    const root = await persist(createAppBuild(null, backend, declaration));
    const release = Schema.decodeUnknownSync(releaseSchema)({
      appId: "app_loader",
      releaseId: "rel_loader",
      artifact: {
        artifactRef: root.artifactRef,
        artifactDigest: root.digest,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: root.digest,
          buildRecipeDigest: root.digest,
        },
      },
    });
    const installation = await approvedInstallation({
      release,
      declaration,
      installationId: "loader-proof",
      instanceId,
    });
    await this.env.REGISTRY.getByName("registry").put(installation);
    const selection = {
      instanceId,
      owner: { kind: "installation" as const, id: "loader-proof" },
      appId: release.appId,
      releaseId: release.releaseId,
      authorityVersion: installation.authorityVersion,
    };
    const applied = await this.apply(
      { ...selection, status: "enabled" },
      release,
      undefined,
      { tenantId: defaultTenant, origin: "https://oyster.invalid" },
    );
    if (!applied.ok)
      throw new Error(
        `Fixture Instance apply failed: ${JSON.stringify(applied)}`,
      );
    const response = await this.backend(
      {
        instanceId,
        selection,
        artifactDigest: backend.digest,
        grants: [{ binding: "INBOX", operations: ["page", "visit"] }],
        subject: {
          kind: "call",
          context: {
            computerId: null,
            actor: { kind: "member", memberId: actor },
          },
        },
        ancestry: [],
        deadlineAt: Date.now() + 30000,
      },
      new Request(`https://guest.invalid/?mode=${mode}`),
      budget === undefined ? undefined : { cpuMs: 5000, subRequests: 12 },
    );
    return {
      status: response.status,
      result: proofResult.parse(await response.json()),
      effects: { ...this.effects },
      actors: { ...this.actors },
      packetRefusal: this.refusals.packet ?? null,
    };
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (request.method === "GET") return new Response("ready");
    const input = z
      .strictObject({
        instanceId: z.string(),
        actor: z.string(),
        mode: z.string(),
        budget: z.literal("subrequests").optional(),
      })
      .parse(await request.json());
    if (!instanceIds.instance.is(input.instanceId))
      return new Response("Invalid Instance", { status: 400 });
    return Response.json(
      await env.INSTANCES.getByName(input.instanceId).runProof(
        input.actor,
        input.mode,
        input.budget,
      ),
    );
  },
};
