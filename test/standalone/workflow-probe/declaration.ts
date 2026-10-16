import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "./methods.js";
export const probeDeclaration = buildAppDeclaration(appBackend, {
  displayName: "Workflow proof App",
  capabilities: ["computer.execute"],
  backend: {
    bindings: [{ name: "COMPUTER", operations: ["workflowGitPass"] }],
  },
  handlers: [],
  roles: [],
});
