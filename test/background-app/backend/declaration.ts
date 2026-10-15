import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "./methods.js";
export const appDeclaration = buildAppDeclaration(appBackend, {
  displayName: "Background host proof",
  capabilities: ["team.workbenchHost"],
  handlers: [],
  roles: [],
  commands: [],
  backend: {
    bindings: [{ name: "APPS", operations: ["catalog"] }],
  },
});
