import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "./methods.js";
export const appDeclaration = buildAppDeclaration(appBackend, {
  displayName: "Storage proof",
  capabilities: ["app.storage", "team.workbenchHost"],
  handlers: [],
  roles: [],
  commands: [],
  storage: [{ key: "desktop", scopes: ["team", "member"], maxBytes: 16384 }],
  backend: {
    bindings: [
      { name: "APP_STORAGE", operations: ["read", "write", "reset"] },
      { name: "APPS", operations: ["catalog"] },
    ],
  },
});
