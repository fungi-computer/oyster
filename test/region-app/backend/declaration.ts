import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "./methods.js";

export const appDeclaration = buildAppDeclaration(appBackend, {
  capabilities: [],
  handlers: [],
  roles: [],
});
