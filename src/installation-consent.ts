import * as Schema from "effect/Schema";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  appCapabilityIdSchema,
  type AppCapabilityId,
} from "@fungi.computer/puffball/app";

/** Private view projection. The installation reducer decodes all submitted grants. */
export const installationConsentSchema = Schema.Struct({
  installationId: Schema.String,
  appId: Schema.String,
  appName: Schema.String,
  authorityVersion: Schema.Int,
  artifactDigest: sha256DigestSchema,
  capabilities: Schema.Array(
    Schema.Struct({
      request: Schema.Struct({
        capability: appCapabilityIdSchema,
        operations: Schema.Array(Schema.String),
        // Preserve the owner's resource selector as JSON; this view cannot mint authority.
        resources: Schema.Json,
      }),
      approved: Schema.Boolean,
      description: Schema.String,
      scope: Schema.String,
    }),
  ),
});

/** Human consent copy; these labels never decide authority or operation mappings. */
export const capabilityLabels = {
  "agent.list": "List Agents",
  "agent.manage": "Create and manage Agents",
  "agent.rename": "Rename Agents",
  "agent.avatar": "Change Agent avatars",
  "agent.toolPolicy": "Allow Agents to use Apps",
  "agent.read": "Read Agent conversations",
  "agent.send": "Send messages to Agents",
  "computer.list": "List Computers",
  "computer.readFile": "Read files",
  "computer.writeFile": "Change files",
  "computer.execute": "Run commands",
  "llm.generation": "Generate text",
  "media.generation": "Generate images and videos",
  "games:servers": "Use game servers",
  "git.repository": "Use Git repositories",
  "apps.open": "Open Apps",
  "apps.call": "Call declared App methods",
  "app.storage": "Store App data",
  "app.events.emit": "Send events",
  "team.workbenchHost": "Arrange the workbench",
  "marketplace.browse": "Browse the marketplace",
  "marketplace.purchase": "Purchase from the marketplace",
  "workflow.run": "Run Workflows",
  "workflow.publish": "Publish Workflows",
  "workflow.arm": "Arm Workflow triggers",
  world: "Connect to external services",
  "channels.read": "Read channels",
  "channels.personal.manage": "Manage personal channels",
} satisfies Record<AppCapabilityId, string>;

/** Plain descriptions of the declared capability; copy never infers extra access. */
export const capabilityDescriptions = {
  "agent.list": "see which Agents are available.",
  "agent.manage": "create Agents and manage their sessions.",
  "agent.rename": "rename Agents you created.",
  "agent.avatar": "change the avatars of Agents you created.",
  "agent.toolPolicy": "approve Agents to use your installed Apps.",
  "agent.read": "read Agent conversations.",
  "agent.send": "send messages to Agents.",
  "computer.list": "see which Computers are available.",
  "computer.readFile": "read files on your Computers.",
  "computer.writeFile": "create and change files on your Computers.",
  "computer.execute": "run commands on your Computers.",
  "llm.generation": "ask AI models to generate text.",
  "media.generation": "ask AI models to generate images and videos.",
  "games:servers": "connect to game servers.",
  "git.repository": "work with Git repositories.",
  "apps.open": "open other Apps.",
  "apps.call":
    "call the listed methods in other Apps as you. Renamed target methods need approval again.",
  "app.storage": "save its App data on your Oyster.",
  "app.events.emit": "tell your Workflows when something happens.",
  "team.workbenchHost": "arrange Apps on your workbench.",
  "marketplace.browse": "browse Apps in the marketplace.",
  "marketplace.purchase": "purchase Apps from the marketplace.",
  "workflow.run": "start Workflows.",
  "workflow.publish": "publish Workflow definitions.",
  "workflow.arm": "enable Workflow triggers.",
  world: "connect to external services.",
  "channels.read": "read messages from channels.",
  "channels.personal.manage": "manage personal channels.",
} satisfies Record<AppCapabilityId, string>;
