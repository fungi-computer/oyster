/**
 * Frozen host wire from Agar 6d30353858e784e749a6cfc47f36b09eb7cf0c22:
 * host.ts PendingHostMount / MountedHost and internal/schemas.ts.
 * Uses the old strict ready/connect shapes, real window messages, transferred
 * MessagePorts and Cap'n Web. Never imports today's Agar host or decoder.
 */
export const agarV2HostSource = `
import * as Schema from "effect/Schema";
import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";

const decode = schema => Schema.decodeUnknownSync(schema, {onExcessProperty:"error"});
const isReady = Schema.is(Schema.Struct({type:Schema.Literal("fungi.app.ready")}));
const readReady = decode(Schema.Struct({
  protocolVersion:Schema.Literal(2), type:Schema.Literal("fungi.app.ready"),
}));
const readRequest = decode(Schema.Struct({
  epoch:Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(160))),
  protocolVersion:Schema.Literal(2),
}));
const epoch = "frozen-host-epoch";
const context = {version:0, value:{
  computerId:"old-host-computer", focus:{editing:false, surface:null},
  openRequest:null, visibility:"visible",
}};
const success = value => ({ok:true, value});
window.frozenHost = {status:"waiting", readyVersions:[], connectVersions:[], toasts:[]};
const fail = cause => {
  window.frozenHost.status = "failed";
  window.frozenHost.error = String(cause);
  window.removeEventListener("message", onReady);
  return {ok:false, error:{code:"PROTOCOL", message:String(cause), retryable:false}};
};
class Host extends RpcTarget {
  connect(value) {
    try {
      const request = readRequest(value);
      if (request.epoch !== epoch) throw new Error("Invalid epoch");
      window.frozenHost.connectVersions.push(request.protocolVersion);
      window.frozenHost.status = "connected";
      return success({
        capabilities:[], context,
        identity:{appId:"app", releaseId:"release", surfaceId:"surface"},
        lifecycle:{version:0, value:"connected"},
        reservedChords:{version:0, value:[]},
        theme:{version:0, value:"dark"},
      });
    } catch (cause) { return fail(cause); }
  }
  reportFocus() { return success(undefined); }
  showToast(value) {
    window.frozenHost.toasts.push(value);
    return success(undefined);
  }
}
function onReady(event) {
  if (!isReady(event.data)) return;
  const frame = document.querySelector("iframe");
  if (event.source !== frame.contentWindow) return;
  try {
    if (event.origin !== "http://current-app.test" || event.ports.length !== 0)
      throw new Error("Invalid App identity or port transfer");
    const ready = readReady(event.data);
    window.frozenHost.readyVersions.push(ready.protocolVersion);
    window.removeEventListener("message", onReady);
    const channel = new MessageChannel();
    const client = newMessagePortRpcSession(channel.port1, new Host());
    window.frozenHostClient = client;
    frame.contentWindow.postMessage({
      epoch, protocolVersion:2, type:"fungi.app.connect",
    }, "http://current-app.test", [channel.port2]);
    client.updateContext(context).then(result => {
      if (!result.ok) fail(result.error.message);
    }, fail);
  } catch (cause) { fail(cause); }
}
window.addEventListener("message", onReady);
window.addEventListener("message", event => {
  if (event.source === document.querySelector("iframe").contentWindow &&
      event.origin === "http://current-app.test" && event.data?.type === "fixture.result")
    window.guestResult = event.data.value;
});
document.querySelector("iframe").src = "http://current-app.test/";
`;
