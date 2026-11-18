import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "./methods.js";
// The same grant shape the probe App declares: an installation with no
// declared grant has nothing for the owner to approve, and the run owner
// refuses to bind it.
export const printsDeclaration = buildAppDeclaration(appBackend, {
  displayName: "Prints",
  capabilities: ["computer.execute"],
  backend: {
    bindings: [{ name: "COMPUTER", operations: ["exec", "processStart"] }],
  },
  handlers: [],
  roles: [],
});
