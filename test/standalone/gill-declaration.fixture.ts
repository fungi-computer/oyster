import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { backend } from "./gill-app.fixture.js";

export const gillDeclaration = buildAppDeclaration(backend, {
  displayName: "Proof App",
  capabilities: [],
  handlers: [],
  roles: [],
  storage: [{ key: "widget-changed", scopes: ["member"], maxBytes: 1024 }],
});
