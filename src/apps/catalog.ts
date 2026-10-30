import type { AppCapabilityId } from "@fungi.computer/puffball/app";
import type { SigilName } from "@fungi.computer/sigils";

/** Consent and resource semantics belong to the grant owner, not its UI. */
export type PermissionCatalogEntry = Readonly<{
  group:
    | "computers"
    | "agents"
    | "generation"
    | "bazaar"
    | "data"
    | "workflows"
    | "git"
    | "channels"
    | "apps"
    | "shell"
    | "other";
  label: string;
  caption: string;
  description: string;
  sigil: SigilName;
  /** Presentation class only; invocation authority always comes from stored grants. */
  consent: "affordance" | "install" | "ask";
  scope: "computer" | "agent" | null;
  warning: string | null;
}>;

function entry(
  group: PermissionCatalogEntry["group"],
  label: string,
  description: string,
  sigil: SigilName,
  consent: PermissionCatalogEntry["consent"],
  scope: PermissionCatalogEntry["scope"] = null,
  warning: string | null = null,
): PermissionCatalogEntry {
  return {
    group,
    label,
    caption: label,
    description,
    sigil,
    consent,
    scope,
    warning,
  };
}

/** Every capability selects one consent class and one resource grammar. */
export const permissionCatalog = {
  approvals: entry(
    "apps",
    "Review approvals",
    // Interim plain consent; the product decision on approvals stays with Levi.
    "This App can approve or deny your Agents' pending actions as you, and turn on automatic approval.",
    "list",
    "ask",
  ),
  "agent.list": entry(
    "agents",
    "List Agents",
    "see which Agents are available.",
    "listAgents",
    "install",
  ),
  "agent.manage": entry(
    "agents",
    "Create and manage Agents",
    "create Agents and manage their sessions.",
    "createAgents",
    "install",
    "agent",
  ),
  "agent.rename": entry(
    "agents",
    "Rename Agents",
    "rename Agents you created.",
    "createAgents",
    "install",
  ),
  "agent.avatar": entry(
    "agents",
    "Change Agent avatars",
    "change the avatars of Agents you created.",
    "createAgents",
    "install",
  ),
  "agent.toolPolicy": entry(
    "agents",
    "Allow Agents to use Apps",
    "approve Agents to use your installed Apps.",
    "createAgents",
    "install",
  ),
  "agent.read": entry(
    "agents",
    "Read Agent conversations",
    "read Agent conversations.",
    "readConversations",
    "install",
    "agent",
  ),
  "agent.send": entry(
    "agents",
    "Send messages to Agents",
    "send messages to Agents.",
    "sendPrompts",
    "install",
    "agent",
  ),
  "computer.list": entry(
    "computers",
    "List Computers",
    "see which Computers are available.",
    "list",
    "install",
    "computer",
  ),
  "computer.readFile": entry(
    "computers",
    "Read files",
    "read files on your Computers.",
    "read",
    "install",
    "computer",
  ),
  "computer.writeFile": entry(
    "computers",
    "Change files",
    "create and change files on your Computers.",
    "write",
    "install",
    "computer",
  ),
  "computer.execute": entry(
    "computers",
    "Run commands",
    "run commands on your Computers.",
    "run",
    "install",
    "computer",
  ),
  "llm.generation": entry(
    "generation",
    "Generate text",
    "ask AI models to generate text.",
    "generateText",
    "install",
  ),
  "media.generation": entry(
    "generation",
    "Generate images and videos",
    "ask AI models to generate images and videos.",
    "generateMedia",
    "install",
  ),
  "games:servers": entry(
    "other",
    "Use game servers",
    "connect to game servers.",
    "list",
    "install",
  ),
  "git.repository": entry(
    "git",
    "Use Git repositories",
    "work with Git repositories.",
    "read",
    "ask",
  ),
  "apps.open": entry(
    "apps",
    "Open Apps",
    "open other Apps.",
    "list",
    "affordance",
  ),
  "apps.call": entry(
    "apps",
    "Call declared App methods",
    "call the listed methods in other Apps as you. Renamed target methods need approval again.",
    "run",
    "install",
  ),
  "app.storage": entry(
    "data",
    "Store App data",
    "save its App data.",
    "write",
    "install",
  ),
  "app.events.emit": entry(
    "workflows",
    "Send events",
    "tell your Workflows when something happens.",
    "sendPrompts",
    "ask",
  ),
  "team.workbenchHost": entry(
    "shell",
    "Shell",
    "Full access to your Team and every App",
    "list",
    "ask",
    null,
    "Only pick a shell you trust.",
  ),
  "marketplace.browse": entry(
    "bazaar",
    "Browse the marketplace",
    "browse Apps in the marketplace.",
    "browseBazaar",
    "install",
  ),
  "marketplace.purchase": entry(
    "bazaar",
    "Purchase from the marketplace",
    "purchase Apps from the marketplace.",
    "buyApps",
    "install",
  ),
  "workflow.run": entry(
    "workflows",
    "Run Workflows",
    "start Workflows.",
    "run",
    "install",
  ),
  "workflow.publish": entry(
    "workflows",
    "Publish Workflows",
    "publish Workflow definitions.",
    "write",
    "ask",
  ),
  "workflow.arm": entry(
    "workflows",
    "Arm Workflow triggers",
    "enable Workflow triggers.",
    "run",
    "ask",
  ),
  world: entry(
    "other",
    "Connect to external services",
    "connect to external services.",
    "list",
    "install",
  ),
  "channels.read": entry(
    "channels",
    "Read channels",
    "read messages from channels.",
    "read",
    "ask",
  ),
  "channels.personal.manage": entry(
    "channels",
    "Manage personal channels",
    "manage personal channels.",
    "write",
    "ask",
  ),
} satisfies Readonly<Record<AppCapabilityId, PermissionCatalogEntry>>;
