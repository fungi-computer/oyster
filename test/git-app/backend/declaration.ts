import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "./methods.js";
export const appDeclaration = buildAppDeclaration(appBackend, {
  displayName: "Git door proof",
  capabilities: ["git.repository"],
  receives: ["git.push"],
  handlers: [],
  roles: [],
  commands: [],
});
