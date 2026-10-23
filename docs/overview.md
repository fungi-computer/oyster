# Oyster API overview

| Import                                  | Export                                                                                             | Purpose                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@fungi.computer/oyster`                | `createAppInstance`                                                                                | Run one App Instance's lifecycle and admission over host-supplied ports.                                                                |
| `@fungi.computer/oyster`                | `InstancePorts`                                                                                    | The storage, artifact resolution, abort, purge and connection ports a host supplies.                                                    |
| `@fungi.computer/oyster`                | `selectionSchema`                                                                                  | Decode the owner-issued selection that authorizes a request.                                                                            |
| `@fungi.computer/oyster`                | `ownerStateSchema`                                                                                 | Decode a complete owner state: `enabled`, `disabled` or `deleted`.                                                                      |
| `@fungi.computer/oyster`                | `AppInstanceError`                                                                                 | Typed rejection with a stable `code` from `appInstanceErrorCodeSchema`.                                                                 |
| `@fungi.computer/oyster`                | `instanceIds`                                                                                      | Mint and recognize App Instance IDs.                                                                                                    |
| `@fungi.computer/oyster/invocation`     | `createInvocationGate`, `invocationFacts`, `InvocationFrame`                                       | Run each request in one frame of host-admitted caller facts, with its deadline and abort signal.                                        |
| `@fungi.computer/oyster/cloudflare`     | `createCloudflareAppInstance`                                                                      | Run an Instance in a SQLite Durable Object with a Worker Loader facet (workerd or celld).                                               |
| `@fungi.computer/oyster/apps`           | `Installation`, `applyInstallationCommand`, `admits`, `approvedBindingGrants`                      | Pure installation approvals and admission; host-owned commits and tenant freshness.                                                     |
| `@fungi.computer/oyster/host`           | `createOyster`                                                                                     | The Oyster App server: a Hono app over host adapters for sign-in, Releases, installations and Instances.                                |
| `@fungi.computer/oyster/auth`           | `ownerKeyAuth`, `ownerOrKeyAuth`                                                                   | Owner-key sign-in (a Bearer key or the login cookie, compared in constant time) and named agent keys as Team-key principals.            |
| `@fungi.computer/oyster/tenant`         | `TenantScope`, `tenantScope`, `singleTenant`, `OysterTenancy`                                      | Host-resolved tenant identity and the scope that prefixes registry, key and repository names.                                           |
| `@fungi.computer/oyster/workers`        | `createOysterWorker`                                                                               | A standalone single-owner Oyster on Workers or celld: R2 Releases, a registry and one Durable Object per Instance.                      |
| `@fungi.computer/oyster/pack`           | `packRelease`, `installRelease`, `installFromSource`, `publishSource`                              | Build a committed App through the canonical recipe compiler and install its Release on an Oyster over HTTP.                             |
| `@fungi.computer/oyster/build`          | `createAppCandidatePreparer`, `createLocalBuildExecutor`                                           | Node-only source capture, pinned compilation and local artifact writing.                                                                |
| `@fungi.computer/oyster/build-contract` | Recipe schemas and candidate orchestration                                                         | The Worker-safe half of `./build`, without the executor.                                                                                |
| `@fungi.computer/oyster/app-storage`    | `AppStorageBinding`                                                                                | `env.APP_STORAGE` for methods and lifecycle handlers: lifecycle writes go to the team layer and reach `appStorage.watch`.               |
| `@fungi.computer/oyster/app-storage`    | `createAppStorage`, `appStorageSchemaStatements`                                                   | SQLite owner for declared keys, live member/lifecycle admission, revision checks and watch invalidations.                               |
| `@fungi.computer/oyster/mcp`            | `oysterAppMethods`, `oysterComputerTools`, `oysterMcpCatalogLoad`                                  | Installed App methods and the host's Computer as Mycelium modules for the shared MCP endpoint, scoped to the caller.                    |
| `@fungi.computer/oyster/agents`         | `OysterAgents`, `agentCapabilities`, `agentApprovalRoutes`                                         | The host's Agent slot, its App capabilities and the owner-only approval routes.                                                         |
| `@fungi.computer/oyster/computer`       | `computerSlots`, `ComputerTerminalHost`                                                            | Computer ports, processes and terminal routes supplied by the host; execution stays in the Computer runtime.                            |
| `@fungi.computer/oyster/media`          | `mediaSlot`                                                                                        | The media capability slot a host fills; Oyster owns routing, never generation.                                                          |
| `@fungi.computer/oyster/files`          | `FileSource`                                                                                       | Files Apps reach through Agar's `computer.*` file contracts, with a compare-and-swap replace.                                           |
| `@fungi.computer/oyster/root-data`      | `createOysterRootData`                                                                             | Installation and verified Release owners as shared workbench metadata for a standalone root.                                            |
| `@fungi.computer/oyster/page`           | `mountOysterPage`, `connectOysterApp`, `readOysterPageConfig`                                      | Mount one installed App's sandboxed frame and connect its admitted slots.                                                               |
| `@fungi.computer/oyster/git`            | `EventSink`, `createGitDoor`, `signStandardWebhook`                                                | The EVENTS binding contract, the git smart-HTTP door and Standard Webhooks signing. `GitBinding` comes from `@fungi.computer/agar/git`. |
| `@fungi.computer/oyster/workers-git`    | `oysterGitRoot`, `createOysterGitWorker`, `ownerOrKeyTenancy`, `oysterWorkerGit`, `gitAdminRoutes` | One Git root whose `hostFor` serves HTTP, MCP and Instances, or `host.git` and key/webhook routes for your own host.                    |

The host owns admission: it decides who may apply owner state and which
selection a request carries. Oyster owns what happens to one Instance once the
host has that authority: owner-state replay and conflict rules, Release
resolution, state-schema compatibility, fencing on disable and purge on delete.
The generated module pages below include every port and record type.

## App Agent send API — breaking change

An App with the `AGENTS.send` binding sends into an existing authorized Session:

```ts
const intent = {
  agentId,
  sessionId,
  requestId: crypto.randomUUID(),
  text: "Continue this work",
  delivery: "followUp" as const,
};

const accepted = await env.AGENTS.send(intent);
// If the outcome is UNKNOWN, retry env.AGENTS.send(intent), unchanged.
```

`requestId` is required, non-empty, and bounded to 256 UTF-8 bytes. Mint it once
per user intent, outside the send/retry function, and retain the same input
until the outcome is known. An UNKNOWN response is not evidence that admission
failed: the recipient may already have accepted the work. Retrying that same
intent must not create another delivery. A new intent needs a new request ID.

The App bridge forwards the caller's ID. The standalone adapter no longer mints
one, and neither path substitutes a transport `callId`. An omitted ID is
refused; there is no compatibility form. Grove's `sendMessage` method requires
and forwards the same field. Admission, the existing send budget, and follow-up
delivery policy are unchanged.

**BREAKING CHANGE:** App `AGENTS.send` and Grove `sendMessage` now require
caller-owned `requestId`. Update existing Apps and their retry state before
using this API. This release note does not authorize a version bump or
publication.

## Guest execution policy

`createOyster({ ...host, guestLimits: { cpuMs: 250, subRequests: 10 } })`
configures per-invocation budgets. Omitted fields default to 1,000 milliseconds
of CPU and 50 subrequests. CPU must be a positive integer; subrequests may be
zero to forbid them. Both must fit a signed 32-bit integer. Invalid
configuration fails before accepting requests.

The host's `InstanceDirectory.get(id, limits)` adapter must carry those budgets
to guest execution.
`createOysterWorker({ guestLimits: { cpuMs: 250, subRequests: 10 } })` supplies
this wiring for the standalone Worker. Direct `createCloudflareAppInstance`
callers can supply the same policy in its final argument; otherwise the same
defaults apply. The loader code carries limits for both HTTP and method calls,
without granting ambient outbound access. Changing an Instance's budgets
invalidates its running facet while preserving its SQLite state. Runtime
enforcement uses the
[Worker Loader resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).

Guest HTTP responses retain only content metadata: content type, language,
encoding, length, disposition and range, accepted ranges, ETag and
last-modified. Oyster supplies `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and a sandboxed, deny-by-default Content
Security Policy. Cookies, redirects, origin policy, service-worker scope and
unrecognized headers cannot come from guests. Host-issued login responses retain
their cookies.

The Node-only `@fungi.computer/oyster/build` entry owns captured App
compilation; `@fungi.computer/oyster/build-contract` provides its Worker-safe
recipe and candidate orchestration without loading the executor.
