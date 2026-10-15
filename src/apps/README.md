# App installation contract

The standalone host uses these pure contracts through `oyster/apps`. Hosts
retain their installation stores, transactions, receipts, revocation and live
resource checks. The Hub's record and gate switches remain separate slices.

An installation pins its immutable Release and `declaredOperationsDigest`.
`deriveDeclaredOperations` takes that Release's verified declaration and the
host's existing capability adapters (`permission`, descriptor id and methods).
It derives backend requirements from Puffball's binding registry. Hosts do not
supply hand-authored operation lists. Canonically sorted operations use
`route:<descriptor id>:<method>` and `binding:<binding name>:<operation>` so an
approval of a browser method cannot silently approve a same-named backend
method. The snapshot digest covers the artifact digest and the derived
capabilities. Hosts recompute this snapshot when resolving a Release and pass it
as a fact.

Stored grants contain one explicit operation list per capability. Resources are
opaque host-minted references or `tenant-scope`, which the host resolves against
its current tenant resources. The pure gate does not resolve resources or check
live grantors. Duplicate capability grants are rejected rather than combining
operation and resource selectors into a wider authorization.

The reducer takes host-minted installation/Instance identities and captured
time. Members may manage installations; only owners approve operations. Upgrades
intersect existing approvals with the new derived operations. They never add an
operation. `external` App methods always return `approval_required`. Method
inputs retain the Hub's 64 KiB bound. Public visitors can invoke read methods;
their binding grants include only approved required read operations, and direct
capability routes still require sign-in.

S2 invocation grants retain the existing `{binding, operations}` shape,
validated with Puffball's registry. The host passes admitted grants into its
maintained invocation frame and rechecks freshness at the effect boundary. This
module has no host callbacks and imports no Hub, Team, billing or broker code.

Retention basis: Hub `team-apps.ts` reducer and `apps/agent-call.ts` admission
at `7384278c69104e930a03e4d584ef08a69da4d601`, plus `app-backend-scopes.ts`'s
requires/effect intersection. This module owns only the pure decisions. HTTP
request parsing, attachment revisions, live grantor and Computer admission,
output decoding, transactions and revocation stay at their existing owners. The
explicit approved-operation list, derived digest and upgrade intersection are
the CTO-approved changes. The standalone switch records the owner's declaration
snapshot at install, intersects it on Release updates, and clears approvals on
deletion. Lifecycle frames carry only `approvedBindingGrants`; freshness checks
compare a running frame as a subset, so a later approval never widens an
existing frame.

`app.events.emit` (Send events) uses the same capability-keyed approval as all
other App capabilities. An emitting App declares it; the maintained binding
registry requires it for `EVENTS.emit`. The derived snapshot contains
`binding:EVENTS:emit`, and the owner approves that explicit operation once.
Without the declared and approved capability, no Events binding reaches the
frame. HTTP and MCP read methods admitted through this gate receive no emit
operation. Direct `Instance.call` callers still need method scoping at their
admission boundary; the universal Worker backstop is a separate slice.
Revocation closes subsequent delivery from an already-entered frame. There is no
binding-keyed grant variant.

Agent App tool policies carry `{level, revision, grantedBy}`. Direct approval
captures the authenticated owner's canonical member ID. The standalone owner key
resolves its configured Identity through the seeded tenancy registry; its name
is not a member ID. The stored approval pins the member's positive
`membershipVersion`. A fresh lookup requires the same current owner and exact
version, so demotion/re-promotion, removal/re-addition or
suspension/reactivation cannot revive an old approval. Missing provenance or
version requires re-approval. Named keys never inherit an Agent's policy: a
key's App access is its own Ear Tag grants, set once at `POST /api/keys` and
read fresh per installation (`keyAppAccess`), never a stored, approved
`{level, revision, grantedBy}` row. `POST /api/keys/revoke` revokes the key and,
with it, every access it ever granted. The installation's approvals remain the
ceiling for every key call.

App-created or App-modified policies record the admitted acting Installation and
remain pending without `grantedBy`. The owner reads
`GET /api/agent-policies/:agentId` for the current revision, then approves
through `PUT /api/agent-policies/:agentId` with that required
`expectedRevision`. These host-owned routes are outside the `agent.manage`
capability prefix; a request bearing an Installation header cannot become
owner-direct. Catalog identity captures the approved policy, and execution
rereads level, revision and grantor before dispatch. Session provenance is
supplied by its separate transport owner.
