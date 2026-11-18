import { connectApp } from "@fungi.computer/agar";
import { appRegion } from "@fungi.computer/agar/backend";
import * as z from "zod";

const status = document.querySelector("#status");
const counter = document.querySelector("#counter");
const scope = document.querySelector("#scope");
const increment = document.querySelector("#increment");
if (
  !(status instanceof HTMLOutputElement) ||
  !(counter instanceof HTMLOutputElement) ||
  !(scope instanceof HTMLOutputElement) ||
  !(increment instanceof HTMLButtonElement)
)
  throw new Error("Region markup is missing");

const stateSchema = z.object({
  counter: z.number(),
  callers: z.array(z.object({ scope: z.json() })),
});

// The host page holds the socket; this sandboxed App only sees its frames.
const root = await connectApp({ host: "parent" });
const connection = await root.capabilities.require(appRegion).connect();
status.value = "Connected";
increment.addEventListener("click", () => {
  void connection.send(JSON.stringify({ kind: "increment" }));
});
const reader = (await connection.messages()).getReader();
for (;;) {
  const next = await reader.read();
  if (next.done) {
    status.value = "Closed";
    break;
  }
  const state = stateSchema.parse(JSON.parse(next.value));
  counter.value = String(state.counter);
  scope.value = JSON.stringify(state.callers.at(-1)?.scope ?? null);
}
