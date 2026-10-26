# @fungi.computer/oyster

## 0.4.0

### Minor Changes

- Changes since 0.3.2:

  - fix(oyster): report unreadable Chromium discovery explicitly
  - feat(oyster): isolate staging browser leases in Chromium contexts
  - fix(oyster): compose model choice in standalone agent owner
  - fix(oyster): preserve standalone mail room contract
  - feat(oyster): persist standalone agent model source choices
  - fix(mesh): replay durable mail receipt after reconstruction
  - fix(computer): restore isolated replay-store subpath
  - fix(mesh): close relay custody review gaps
  - feat(oyster): retain offline machine-link posts
  - fix(mesh): stage standalone acceptance notices
  - feat(mesh): wip sessionless acceptance checkpoint
  - fix(oyster): reconcile Computer snapshot with attachment revision
  - fix(oyster): prepare Home Computers on first use
  - feat(local): back off mesh redials and refuse incompatible protocol
  - feat(mesh): distinguish held delegation mail
  - fix(oyster): defer Computer snapshot to capability acquisition
  - fix(oyster): keep Worker fleet declarations out of Node host types
  - fix(oyster): export admission projection fields
  - fix(oyster): require confirmation for MCP Workspace calls
  - fix(oyster): admit configured Agent Computers through registry resolve
  - feat(oyster): share Computer MCP fleet controls with Hub
  - feat(oyster): attach Agents to named Computers
  - feat(mesh): report terminal undeliverable mail replies
  - fix(mesh): keep mail size enforcement in BirdDog schema
  - feat(bird-dog): bound mail content by UTF-8 bytes

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/bird-dog@0.2.0
  - @fungi.computer/caps@0.3.0
  - @fungi.computer/carrier@0.2.0
  - @fungi.computer/computer@0.3.0
  - @fungi.computer/knapsack@0.3.0
  - @fungi.computer/seam@0.2.0
  - @fungi.computer/shiitake-extensions@0.2.0
  - @fungi.computer/shiitake@0.4.0
  - @fungi.computer/agar@0.3.1
  - @fungi.computer/computer-contract@0.0.3
  - @fungi.computer/mycelium@0.2.2
  - @fungi.computer/zookeeper@0.0.3
  - @fungi.computer/braid@0.2.2
  - @fungi.computer/darkroom@0.2.1
  - @fungi.computer/nacre@0.0.2
  - @fungi.computer/workflows-wire@0.2.2

## 0.3.2

### Patch Changes

- Changes since 0.3.1:

  - fix(oyster): require confirmation for MCP Workspace calls
  - fix(oyster): fence preview origins before routes
  - fix(oyster): surface typed seed refusals on all routes
  - fix(oyster): create seed refusal responses per request
  - fix(oyster): refuse standalone origin mismatches before seeding
  - fix(oyster): use tail-redacted boot token header
  - fix(oyster): scope APPS build status jobs to caller installation
  - fix(oyster): redact boot capability header from mount diagnostics
  - fix(oyster): include refusal worker files in stranger inventory
  - fix(mule): own provider data types at the Pi boundary
  - fix(oyster): keep MCP SDK declarations out of Worker graph

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/computer@0.2.2
  - @fungi.computer/knapsack@0.2.1
  - @fungi.computer/shiitake-extensions@0.1.1
  - @fungi.computer/shiitake@0.3.1
  - @fungi.computer/computer-contract@0.0.2
  - @fungi.computer/mycelium@0.2.1
  - @fungi.computer/zookeeper@0.0.2
  - @fungi.computer/braid@0.2.1
  - @fungi.computer/workflows-wire@0.2.1

## 0.3.1

### Patch Changes

- Changes since 0.3.0:

  - test(oyster): registry fakes answer storeFromOlderOyster like the real
    registry
  - fix(oyster): keep the Worker refusal out of the CLI's module graph
  - fix(oyster): keep older-store helpers private and their types public
  - fix(oyster): decode the older-store refusal without swallowing body errors
  - fix(oyster): cache clean registry answers, tighten older-store wording,
    reset steps and tests
  - fix(oyster): refuse a store created by Oyster 0.2 or earlier
  - fix(computer): read ignore rules without loading the ai-dependent tools
    entry

- Updated dependencies
  - @fungi.computer/computer@0.2.1

## 0.3.0

### Minor Changes

- Changes since 0.2.0:

  - feat(stranger): carry compiler options in each typecheck environment
  - feat(stranger): typecheck each public entry in its own environment
  - fix(stranger): align the Oyster closure inventories and local dependencies
  - test(oyster): use valid first-reply release identities
  - fix(oyster): move private host qualification to Hub
  - test(oyster): prove first Agent reply uses native Shed lease
  - test(oyster): navigate back to phone workflow scope
  - fix(oyster): keep Stage out of the starter release
  - test(oyster): follow current Trellis host navigation
  - test(oyster): await current Trellis Runs home
  - test(oyster): approve trusted shell and collect standalone failures
  - test(oyster): capture a Workflow node's COMPUTER exec binding, not the
    retired mint
  - test(oyster): run the standalone Workflow native proof on the local Computer
    container
  - test(oyster): prove the standalone Git step through native commands only
  - feat: join Workflow Git to the native Computer's execution lifecycle
  - feat(oyster): carry a standalone Workflow Git step's public grant to its
    commands
  - docs(oyster): regenerate App-disable API pages
  - feat(oyster): supply standalone Workflow Git execution hooks and native
    liveness
  - docs(oyster): describe per-invocation Workflow Git credentials
  - test(oyster): refuse mismatched standalone Workflow Git credentials at the
    run owner
  - test(oyster): route each library's Workflow Git bearer to its own run owner
  - refactor(oyster)!: migrate standalone Workflow Git to per-invocation
    credentials
  - fix(apps): stop in-flight App work on disable
  - feat: show the Fungi sigil in the tab of each Fungi web surface
  - docs: plain Oyster lead and one Node story for Shiitake
  - style(oyster): make retention void and string conversions explicit
  - refactor(oyster): retain settled installation journals for ninety days
  - test(oyster): refresh native pack completion fixture
  - fix(oyster): keep journal qualification lint clean
  - refactor(oyster): compact settled installation journal payloads
  - test(oyster): keep preview-refusal fixtures lint clean
  - fix(oyster): surface obsolete provisional results on owner reads
  - test(oyster): red - refuse obsolete provisional outcomes on operation reads
  - fix(oyster): refuse obsolete preview records with republish guidance
  - test(oyster): red - refuse obsolete preview operations with republish
    guidance
  - fix: retry inconclusive publication once and reuse prepared UI checks
  - test: red - one browser session per install; the publisher retries an
    inconclusive check once
  - style(oyster): use array syntax for native operation trace
  - test(oyster): use native URL for store reopen fixtures
  - refactor(oyster): remove legacy build-store conversions
  - fix(oyster): boot-page-v2, so results recorded under the old rules are never
    read
  - fix(oyster): only verdicts about the candidate are mount failures
  - test(oyster): red - only candidate verdicts are mount failures
  - fix(oyster): a dropped browser or an unfinished load is inconclusive, not a
    mount failure
  - test(oyster): red - a dropped browser or an unfinished load is not a mount
    verdict
  - fix(approvals): declare the approval-routed App operation and clear bundle
    lint
  - test(oyster): prove per-device machine-link replay capacity
  - refactor(oyster)!: route machine-homed Agents by device only
  - test(oyster): red - a machine home routes by device only
  - fix(oyster): number App writes by Mycelium's operation position
  - fix(agar): discover the parent host without a referrer
  - test: poll chromium's devtools port without silent catches
  - refactor(oyster): delete the playwright boot stack; both hosts check the ui
    through checkBootPage
  - docs(oyster): remove stale ignored-build failure advice
  - docs(oyster): declare pnpm build policy before fresh installation
  - fix(oyster): a release without a UI passes before the browser is asked for
  - test(oyster): red - a release without a UI passes on a host without a
    browser
  - fix(docs): repair Oyster setup and name terminal entry points
  - feat(oyster): the boot route accepts http only on loopback
  - fix(package-docs): skip packages whose contract declares docs not applicable
  - test(oyster): red - the boot route accepts http only on loopback, as the
    boot check opens it
  - feat(oyster): reportBootPage, the one UI page check for every host
  - test(oyster): red - one boot page report for every host
  - feat(hub): serve the pinned boot page on the app origin
  - feat(oyster): issueBootCapability, the one boot lease issuer
  - test(oyster): red - one boot capability issuer for every host
  - refactor(oyster)!: lend Shiitake's Agent grammar to the machine link as host
    ports
  - feat(oyster): warn in install-apps when an App's UI check did not pass
  - test(hub): red - the Hub BootCapabilityStore over the catalog rows (A1, A2)
  - test(oyster): register the boot capability and mount tests
  - test(oyster): give the standalone installer fake its uiCheck
  - test(oyster): give boot fakes the report-only install contract
  - fix(oyster): clear machine-link fence lint findings
  - fix(oyster): every dropped promise and caught error has an explicit outcome
  - fix(oyster): give the machine-link message failure one owner
  - fix(oyster): classify boot runner startup failures
  - fix(oyster): report bounded boot failure diagnostics
  - docs(oyster): publish boot check types
  - fix(mesh): clear the gate Fallow findings on the B4 bundle
  - fix(oyster): export the proof Registry's environment type
  - feat(puffball,hub): one boot result per Release and check version
  - test(oyster): prove real Local machine link lifecycle end to end
  - test(oyster): distinguish host-skipped UI check
  - feat(oyster): name host-skipped UI checks
  - fix(oyster): preserve nullable boot check outcomes
  - fix(oyster): explicitly refuse machine targets without Agent callers
  - fix(oyster): any new page other than the boot page is unexpected
  - test(oyster): red - any new page other than the boot page is unexpected
  - fix(oyster): ignore the boot page's own attach; scope the token to the
    release
  - fix(oyster): preserve settlement refusal across machine routing
  - test(oyster): red - boot token only under the release path; popups
    unexpected
  - test(oyster): red - the root page's own attach event is not a child frame
  - chore(oyster): list the standalone browser host in the tarball manifest
  - fix(oyster): bound the boot connect, gate child frames, token only on
    exact-origin requests
  - test(oyster): red - boot token only on exact-origin requests
  - test(oyster): red - boot connect is bounded and child frames wait for their
    gate
  - chore(oyster): list the ./browser and ./browser/boot files in the tarball
    manifest
  - feat(oyster): boot check on the shared browser module (./browser/boot)
  - feat(oyster): report UI boot outcomes on install operations
  - test(oyster): red - the boot check opens only its pinned candidate page on
    its own session
  - fix(oyster): the teardown owner takes a provider session from the moment it
    exists
  - test(oyster): red - a created but unconnected provider session stays owned
    for teardown
  - fix(oyster)!: align standalone machine admission
  - feat(billing): bill cloud browser time in real milliseconds
  - fix(oyster): keep provider teardown owned and count in-flight opens against
    the cap
  - test(oyster): red - provider teardown stays owned and the cap counts opens
    in flight
  - docs(oyster): document the ./browser module and the Agent browser
  - test(oyster): agents sandbox binds the standalone root's own DO classes
  - test(browser): retain idempotent same-team member resume
  - test(oyster): type the quick-read billing ledger assertions
  - test(browser): follow per-execution metering contract
  - test(oyster): browser e2e binds the standalone root's own DO classes
  - test(oyster): move browser laws to shared module
  - test(oyster): prove standalone browser source laws
  - feat(browser): bill Quick Reads through the same required meter
  - fix(oyster): scope Workflow installs to the calling installation's own App
  - test(oyster): red - quick reads hold, settle reported browser time, release
    on failure
  - test(oyster): keep the account id out of browser e2e failure output
  - feat(oyster): standalone Agents get the cloudBrowser tool on their BROWSER
    binding
  - test(oyster): red e2e - a standalone Agent browses a page through its
    BROWSER binding
  - fix(oyster)!: honor the standalone machine join contract
  - chore(oyster): typecheck the browser module tests
  - feat(oyster): browser sessions take an explicit CDP transport; browser test
    config
  - refactor(oyster): move the Hub cloud browser into
    @fungi.computer/oyster/browser
  - fix(app-publisher): support host-hydrated offline metadata cache
  - fix(bonsai,oyster)!: share the repository App source wire through
    workflows-wire
  - feat(machine-link): commit and push lifecycle fence facts
  - fix(oyster): list every emitted machine-link artifact in the stranger
    inventory
  - feat(oyster): carry bounded mount diagnostics
  - refactor(oyster)!: move device delivery and the hosted machine-agent client
    into the module
  - docs(oyster): document the durable installation owner API
  - test: specify bounded boot mount diagnostics
  - test(mesh): prove erased-Team machine-link fences
  - test(oyster): cover standalone enrollment with direct bearer requests
  - fix(oyster,bonsai): export the types public signatures use
  - feat(oyster)!: add standalone one-use machine enrollment and link authority
  - fix(approvals): wake for expiry and results, mint delivery ids, refuse keys
    early
  - fix(oyster): replace Fallow member exemptions with RPC contracts
  - test(oyster): checkpoint standalone machine join missing-route RED
  - feat(oyster): own member login fencing and erasure retirement
  - fix(approvals): retried Oyster requests report status, never claim
  - fix(oyster): enforce the device sender check inside the machine link
  - feat(oyster): admit narrow machine enrollment key grants
  - refactor(oyster)!: compose the machine link behind one authority port
  - refactor(oyster)!: move agent delegation to shared subpath
  - feat(hub): serve Team approvals to member App windows
  - refactor(oyster)!: move the machine link into
    @fungi.computer/oyster/machine-link
  - fix(oyster): install Workflow builds through the durable owner
  - feat(oyster): admit narrow machine enrollment key grants
  - fix(oyster): satisfy lint in Workflow install origin rule
  - fix(oyster): retain install origin and refuse new Workflow approval
  - fix(oyster): accept proxy-launched pinned celld in native proofs
  - fix(oyster): prepare native proof before importing outputs
  - test(oyster): cover Workflow install admission guards
  - fix(oyster): migrate Tourtois browser installation caller
  - fix(oyster): migrate remaining native installation callers
  - fix(oyster): decode callable native RPC namespaces
  - fix(oyster): migrate retained native installation callers
  - test(seam): witness neutral machine-link public entry
  - fix(oyster): refuse installation without explicit provenance
  - test(oyster): supply named registry identities in owner fixtures
  - fix(oyster): complete strict caller and retirement fixture migration
  - fix(oyster): leave App assets to Vite during import planning
  - fix(oyster): preserve durable webhook admission across wake failure
  - test(oyster): match lifetime assertion to current boot producer
  - fix(authoring): preserve Workflow refusals across lifecycle and native RPC
  - fix(oyster): select App compile roots from runtime imports
  - refactor(mesh)!: move shared machine-link protocol into Seam
  - feat(oyster): expose correlated admission in App CLI
  - Revert "fix(bonsai): remove impossible local App release command"
  - fix(bonsai): remove impossible local App release command
  - docs(oyster): refresh authoring API projections
  - fix(oyster): make admission and native failure outcomes explicit
  - fix(oyster): wire registry-owned installation delivery and preserve earliest
    wake
  - refactor(oyster): share webhook and native workflow mechanisms
  - fix(oyster): checkpoint durable installation owner and correlated client
  - fix(approvals): commit native intent and alarm together
  - fix(oyster): complete boot UI lifecycle corrections
  - chore(b3a): checkpoint native workflow consumers and shared renderer types
  - feat(mesh)!: preserve caller-owned intents across Local reconnects
  - fix(approvals): reconcile native Oyster alarm work
  - fix(approvals): seal homes and bound native catalogs
  - fix(b3a): align template and native proof consumers
  - fix(webhooks): use the portable Headers interface at ingress
  - fix(oyster): close boot UI deadline and capability gaps
  - fix(workflows): compose current Hub Teams and prove native webhook restart
  - chore(b3a): checkpoint manual workflow integration
  - test(workflows): send the complete retained webhook target
  - test(oyster): reach retained webhook laws from standalone gate
  - test(workflows): join real publication to native webhook control red-first
  - feat(approvals): checkpoint native consent and clean-break consumers
  - fix(oyster): narrow MCP event-store type projection
  - fix(oyster): close boot boundary lint findings
  - test(oyster): expect not-found for foreign Computer admission
  - refactor: move repository installation into Workflow nodes
  - fix(mesh): retain send failures and account-owned enrollment
  - test(oyster): capture fatal install response after lost acknowledgement
  - feat(mesh): carry bounded Post receipts over a shared link
  - refactor(oyster): make browser cleanup callbacks explicit
  - test(oyster): use declared categories and the actual graceful disconnect
    door
  - test(oyster): prove selection lifetime and cross-mount command isolation
  - feat(tui): isolate independent leader and Grove bundle
  - test(oyster): couple in-memory response cancellation through Web Streams
  - test(oyster): preserve native Request init semantics in the DOM fixture
  - test(oyster): identify the native Request constructor used by the DOM
    fixture
  - docs: regenerate command view and Oyster UI APIs through native writers
  - test(oyster): distinguish Request retargeting from RPC write admission
  - test(oyster): identify the fixture method at the Fetch boundary
  - test(oyster): isolate the admitted Agent write handle before UI dispatch
  - test(oyster): trace the fixture claim response for transport diagnosis
  - test(oyster): surface real browser connection failure during discovery
  - test(oyster): release the UI run borrow before closing its runtime
  - feat(oyster): bind one selected Session to its admitted App command view
  - fix(oyster): retain App source ordering when adding Session UI
  - test(oyster): observe UI through the compiled Mycelium catalog
  - fix(oyster): use the public lazy Knapsack factory for Session UI
  - feat(oyster): serve the existing Session UI connection from standalone
    Agents
  - fix(oyster): move retained native proofs to current schema homes
  - refactor(oyster): give Workflow installs the consent-bounded origin
  - test(oyster): require admitted Agent browser routes and Session UI source
  - fix(oyster): stream boot UI artifacts by reference
  - fix(tourtois): inject host-owned key decoders
  - test(oyster): move retained capability callers off null targets
  - fix(oyster): align fleet proofs with parsed request contracts
  - feat(workflows): admit published runs from Git-push lifecycle frames
  - test(oyster): preserve browser parent identity in the DOM fixture
  - test(oyster): bind the real parent Window and own pending handshakes
  - test(oyster): distinguish handshake setup from missing browser wiring
  - test(oyster): trace App Session selection to the browser bridge
  - fix(oyster): confirm browser session cleanup before activation
  - test(oyster): expose configured Computer choice refusal
  - fix(oyster): clean up synchronous reduction and unused hook inputs
  - test(oyster): expect retired installation consent refusal
  - feat(apps): discover repository builds and install local Releases
  - fix(oyster): own browser sessions before DevTools connection
  - feat(approvals): persist deferred message delivery receipts
  - test(oyster): retain fleet preview ingress regression
  - fix(oyster): make browser cleanup refusal an explicit outcome
  - fix(oyster): resolve generated boot bridge through package imports
  - feat(apps): resume approved installs for accepted main builds
  - feat(approvals): add durable ledger and bound page control
  - fix(oyster): omit undefined pack options
  - fix(oyster)!: boot Worker-hosted UIs with Browser Rendering
  - fix(oyster): qualify settings consumers and test registration
  - feat(oyster): compose per-Computer Internet access controls
  - feat(apps): retain typed build installation outcomes in Settings
  - test(oyster): align remaining construction fixture consumers
  - feat(recall): finish hosted ownership and pending lane supersede
  - test(oyster): align construction fixtures with batch gate runners
  - docs(api): regenerate joined Oyster and Maosaico references
  - fix(oyster): gate automatic release selection on existing approval
  - test(apps): prove honest build refusals through host and Settings
  - fix(oyster): document current host and permission projections
  - fix(oyster): associate consent checkboxes with their field labels
  - fix(oyster): preserve typed build preflight refusals
  - fix(agents): migrate hosted recall send consumers
  - test(oyster): respect decoded approval and scoped Settings fields
  - fix(oyster): recognize approved same-Computer permission replays
  - feat(oyster): copy-seed backend construction checks
  - test(oyster): distinguish attested and missing window consent
  - test(oyster): assert the persisted window capability approval
  - feat(oyster): bind window Allow to its host Computer
  - chore(oyster): checkpoint window-scoped consent work
  - fix(oyster)!: pass prior state schema to lifecycle boot
  - test(oyster): generate the browser fixture Instance identity
  - test(oyster): use current approval and Settings fixture contracts
  - test(oyster): register machine-link control grammar
  - feat(oyster): compose owner fleet and per-window Computer context
  - fix(oyster)!: record repository registration contract removal
  - feat(oyster): decode bounded machine read controls
  - feat(oyster): register Apps from committed repository metadata
  - feat(mule): freeze typed retry core and model-owner adapters
  - fix(oyster): decode permission bodies and adopt live fixture authority
  - fix(authoring): qualify recipe policy snapshots and test inputs
  - fix(oyster): project the selected App metadata to its source root
  - test(oyster): require App metadata at the projected repository root
  - test(oyster): cover captured arming approval changes
  - fix(oyster): require stored consent for apps.open
  - fix(media): preserve safe provider diagnostics through replay
  - fix(oyster)!: recover activation and refuse unsupported authority
  - test(oyster): prove Agent Trellis arming provenance
  - fix(oyster): expose machine Agent delivery homes
  - feat(oyster): adopt committed activation in host callers
  - feat(oyster): decode bounded machine leave frames
  - fix(mule): qualify retry contract declarations and bundle boundaries
  - fix(oyster): project imported host types in public docs
  - feat(ear-tag): own delegated key authority and shared wire contract
  - test(oyster): pin captured recipe digest to build policy v3
  - fix(oyster): document current permission type projections
  - fix(oyster): declare the Notes snapshot compiler
  - feat(oyster): fence activation and keep worker preflight transient
  - fix(oyster): pin the Notes UI build toolchain
  - fix(oyster)!: record the manifest recipe API break
  - fix(oyster): clear page asset lint errors
  - refactor(mule): require typed retry contracts across model owners
  - fix(oyster): give Notes its own workspace build boundary
  - feat(oyster): derive App build recipes from package metadata
  - fix(oyster): refuse and retry failed page asset acquisition
  - docs(oyster): describe bounded permission saves and generation pins
  - refactor(oyster): share write-free instance preflight with activation
  - fix(oyster): defer host page assets until first request
  - docs(oyster): project host service contracts inline
  - feat(oyster): decode machine Agent delivery homes
  - fix(oyster): project public permission types without private schemas
  - feat(oyster): fence permission saves by durable store generation
  - refactor(extensions): own conversation Agent roster outside Oyster
  - feat(oyster): replace whole-grant saves with bounded owner changes
  - feat(oyster): centralize permission consent and minimal draft planning
  - refactor(oyster): isolate Instance identity from runtime imports
  - feat(oyster): pin deferred page-assets source port
  - fix(oyster): make minted installation ids create-only
  - fix(oyster): keep Agent composition in the existing host pack
  - test(oyster): fence held binding writes after retired-id reinstall
  - fix(oyster): mint a fresh installation id after retirement
  - fix(packages): align split-package test consumers
  - fix(oyster): defer Agent runtime capabilities and use built bindings
  - fix(oyster): retire a deleted installation id
  - refactor(oyster)!: move the shell client into @fungi.computer/nacre
  - refactor(computer)!: move the operation contract into computer-contract
  - Revert "fix(oyster): continue the authority version across a reinstall"
  - Revert "test(oyster): pin the stale Permissions tab outcome and tombstone
    row"
  - test(oyster): run the installation commit race in the package suite
  - fix(oyster): commit every installation write over its read version
  - test(oyster): pin the stale Permissions tab outcome and tombstone row
  - fix(hub): record each conversation's created Agents in its footer
  - fix(oyster): name permission signature types publicly
  - fix(oyster): continue the authority version across a reinstall
  - fix(oyster): prepare the conversation footer record on first use
  - fix(oyster): import the shell through an uncached host entry
  - fix(oyster): list each conversation's created or sent Agents in its footer
  - fix(oyster): recheck shell entry approval at import
  - fix(oyster): correct webhook owner and consumer contracts
  - fix(oyster): expose live Agent RPC and remove unused Computer RPC
  - fix(oyster): require approved grants for home shell admission
  - fix(oyster): single-flight cold MCP owner construction
  - test(oyster): migrate retained delivery and root fixtures
  - fix(agents): recheck reply disclosure on every Post attempt
  - fix(workflows): keep webhook concurrency schema private
  - test(permissions): migrate authority and consent consumer fixtures
  - fix(workflows): decode webhook commands with typed outcomes
  - fix(agents): deliver recipient-owned delegation evidence through Post
  - fix(workflows): preserve webhook callback receivers
  - test(oyster): prepare permission proofs for merged boot gate
  - fix(oyster): preserve incoming Worker request in fallback
  - test(oyster): compare complete pnpm fixture inventory
  - chore(agents): preserve Option A work before the 02 ancestry merge
  - test(oyster): avoid repeated pnpm fixture discovery
  - test(oyster): preserve canonical preview qualification corrections (WIP)
  - test(oyster): align host fixtures with boot admission
  - fix(hub): keep boot adapters out of shared preview
  - fix(oyster): preserve boot budgets and align construction fixtures
  - feat(workflows): mount library ingress and retained wake recovery
  - fix(oyster): make trusted boot parent own its browser entry
  - fix(workflows): bound native webhook rate keys
  - test(oyster): add paired Media preview and restart assertions (WIP)
  - feat(workflows): join webhook delivery to retained run reservations
  - feat(oyster): checkpoint host-owned activation boot gate
  - test(oyster): decode owner grant projection before field access
  - test(oyster): extend existing native fleet qualification scenarios (WIP)
  - fix(oyster): provision fresh defaults through ordinary owner grants
  - feat(workflows): guard binding admission at durable start and capture
    custody atomically
  - chore(app-permissions-01): checkpoint native and refusal proof WIP
  - chore(app-permissions-01): fix native origin fixture and narrow gate facts
    WIP
  - feat(oyster): route existing Computer picker and signed previews through
    fleet
  - chore(app-permissions-01): align standalone authority fixtures WIP
  - feat(oyster): persist Computer selection and pin async host snapshots
  - chore(app-permissions-01): checkpoint embedded installation authority WIP
  - feat(workflows): checkpoint private webhook custody and durable intake
    primitives
  - chore(oyster): wip extraction pending host adapter corrections
  - test(oyster): exercise workflow control composition and agent provenance
  - fix(apps): type the seed-kind producer without assertions
  - test(app-permissions-01): cover upgrade pending and approval refusal
  - chore(app-permissions-01): checkpoint standalone consent persistence WIP
  - feat(oyster): add owner fleet inventory and start controls
  - chore(app-permissions-01): checkpoint shared reducer and approval projection
    WIP
  - feat(oyster): share retained workflow controls with Hub
  - chore(app-permissions-01): checkpoint scoped admission and shell policy WIP
  - feat(apps): first-party Apps update like normal Apps (app-release-v1-15)
  - perf(oyster): do not reproject or notify panes on focus-only changes
  - fix(oyster): settle every seed and build before install-apps rejects; inject
    the idle wait
  - perf(oyster): read build status before idle wait; build each App as soon as
    it is seeded
  - fix(oyster): install-apps --help and a missing-variable error that says
    where each comes from
  - perf(oyster): ship only the sans font on login
  - fix(oyster): name the next step on the empty home
  - fix(stage): declare no icon until the stage sigil exists
  - test(oyster): prove the agent durable object passes the store keeping
  - feat(oyster): add stage to the starter apps
  - feat(oyster): enforce storage pressure and run the patrol in the agent
    durable object
  - feat(shiitake): run on pi-ai 1.3.0
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.3.0
  - @fungi.computer/bird-dog@0.1.0
  - @fungi.computer/braid@0.2.0
  - @fungi.computer/burrow@0.1.0
  - @fungi.computer/cairn@0.1.0
  - @fungi.computer/caps@0.2.0
  - @fungi.computer/carrier@0.1.0
  - @fungi.computer/computer-contract@0.0.1
  - @fungi.computer/computer@0.2.0
  - @fungi.computer/darkroom@0.2.0
  - @fungi.computer/ear-tag@0.1.0
  - @fungi.computer/forage@0.2.0
  - @fungi.computer/gills@0.2.0
  - @fungi.computer/knapsack@0.2.0
  - @fungi.computer/mycelium@0.2.0
  - @fungi.computer/nacre@0.0.1
  - @fungi.computer/puffball@0.2.0
  - @fungi.computer/seam@0.1.0
  - @fungi.computer/shiitake-extensions@0.1.0
  - @fungi.computer/shiitake@0.3.0
  - @fungi.computer/sigils@0.2.0
  - @fungi.computer/sprite-zdog@0.2.0
  - @fungi.computer/sprite@0.2.0
  - @fungi.computer/veil@0.2.0
  - @fungi.computer/watchdog@0.1.0
  - @fungi.computer/whistle@0.1.0
  - @fungi.computer/workflows-wire@0.2.0
  - @fungi.computer/zookeeper@0.0.1

## 0.2.0

### Minor Changes

- Changes since 0.1.0:

  - fix(hub): project Agent avatars as closed records
  - test(oyster): give the MCP proof's Agent its avatar
  - fix(agar): keep the result-row decoder out of Apps that do not present
  - feat(agents): make the avatar a property of the Agent, not the conversation
  - fix(trellis): no silent failures on the run views and step presentation
  - feat(shed): one Ghostty terminal for the light and full shells
  - feat(sigils): wire round-two Sigils into every surface
  - perf(oyster): build schemas on first use, not at import
  - feat(tourtois): render app crumbs, commands and state in the window header
  - feat(agar): let App methods declare how a finished call reads
  - feat(oyster): public release 0.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.2.0
  - @fungi.computer/braid@0.1.0
  - @fungi.computer/caps@0.1.0
  - @fungi.computer/computer@0.1.0
  - @fungi.computer/darkroom@0.1.0
  - @fungi.computer/ear-tag@0.0.2
  - @fungi.computer/forage@0.1.0
  - @fungi.computer/gills@0.1.0
  - @fungi.computer/knapsack@0.1.0
  - @fungi.computer/mycelium@0.1.0
  - @fungi.computer/puffball@0.1.0
  - @fungi.computer/shiitake@0.2.0
  - @fungi.computer/sigils@0.1.0
  - @fungi.computer/sprite-zdog@0.1.0
  - @fungi.computer/sprite@0.1.0
  - @fungi.computer/veil@0.1.0
  - @fungi.computer/whistle@0.0.2
  - @fungi.computer/workflows-wire@0.1.0

## 0.1.0

### Minor Changes

- Changes since 0.0.1:

  - perf(oyster): defer heavy SDKs out of Worker startup
  - chore(apps): drop -app from the starter App package names
  - fix(trellis): follow the rename in the git-transport fixture URLs and
    publication-plan hashes
  - fix(oyster): keep the standalone workflows root fixture import names
    consistent
  - feat(trellis): rename the Workflows App to Trellis
  - feat(computer): move every platform Computer to standard-4
  - docs(oyster): open the README on the live desktop and its seven Apps
  - fix(oyster): report or propagate the candidate builder's and installer's
    failures
  - refactor: keep Oyster's host in the packages layer
  - test(oyster): keep the media slot Darkroom-free; only the standalone host
    brings it
  - fix(oyster): install starter Apps one build at a time by default
  - docs(oyster): deploy the whole host and install the seven starter Apps
  - fix(apps): build split App repositories from registry packages
  - build(release): list the standalone host closure and the seven starter Apps
    for export
  - test(oyster): node-run proofs import the installer and directory schema from
    the package
  - feat(oyster): install starter Apps from their own repositories, two builds
    at a time
  - refactor(oyster): make Oyster the full standalone host
  - test(oyster): give the key-expiry route test a window a loaded host can meet
  - fix(oyster): keep a build running when the Computer loses its result
  - fix(oyster): keep a build alive across a build owner restart
  - refactor(oyster): keep contentArtifactRef private to the artifact writer
  - fix(oyster): drain an already-stored object's upload instead of cancelling
    it
  - feat(hub): submit Team App candidates by manifest with streamed objects
  - feat(app-publisher): persist Team candidate manifests from streamed objects
  - test(oyster): prove manifest submissions, streamed object uploads and the
    builder layout
  - feat(oyster): build candidates by manifest with streamed objects
  - feat(oyster): seed App templates with an ordinary git push
  - fix(oyster): fail a build whose owner restarted instead of leaving it
    running
  - fix(oyster): seed App templates without a working tree or index
  - docs(oyster): document App directory permission contracts
  - docs(oyster): state current demo App availability plainly
  - docs(oyster): clarify Fungi App set and host boundary
  - test(bonsai): read provider refs asynchronously; keep fixture paths and
    readers whole
  - fix(oyster,bonsai): activate fresh template repositories; compose the
    Registry's Git
  - fix(oyster): decode template identity without swallowing errors
  - fix(oyster): build storage converts in one transaction; template admission
    looks up its App
  - test(oyster): a declared package script runs alone, against real pnpm
  - fix(oyster): a build job persists its explicit source location
  - refactor(oyster): the current toolchain reads a workspace page by its entry
  - feat(oyster): a Computer build runs a dependency's declared package script
  - feat(oyster): an App's published template is its Computer build source
  - fix(oyster): a later App source distribution fast-forwards its template
  - fix(oyster): host builds keep their recipe's output and asset bounds
  - fix(oyster): resolve copied example schemas from consumer root
  - refactor(app-publisher): the R2 artifact writer returns to its one user
  - fix(oyster): publishSource pins the captured recipe its template carries
  - fix(oyster,bonsai): builds share Oyster's artifact representation; big
    pushes record

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.1.0
  - @fungi.computer/braid@0.0.1
  - @fungi.computer/burrow@0.0.2
  - @fungi.computer/caps@0.0.2
  - @fungi.computer/computer@0.0.1
  - @fungi.computer/darkroom@0.0.1
  - @fungi.computer/knapsack@0.0.2
  - @fungi.computer/puffball@0.0.2
  - @fungi.computer/shiitake@0.1.0
  - @fungi.computer/veil@0.0.1
  - @fungi.computer/workflows-wire@0.0.1
  - @fungi.computer/mycelium@0.0.2
  - @fungi.computer/forage@0.0.2

## 0.0.1

### Patch Changes

- Inaugural public release of @fungi.computer/oyster.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.0.1
  - @fungi.computer/burrow@0.0.1
  - @fungi.computer/cairn@0.0.1
  - @fungi.computer/caps@0.0.1
  - @fungi.computer/carrier@0.0.1
  - @fungi.computer/ear-tag@0.0.1
  - @fungi.computer/forage@0.0.1
  - @fungi.computer/gills@0.0.1
  - @fungi.computer/knapsack@0.0.1
  - @fungi.computer/mycelium@0.0.1
  - @fungi.computer/puffball@0.0.1
  - @fungi.computer/sigils@0.0.1
  - @fungi.computer/watchdog@0.0.1
  - @fungi.computer/whistle@0.0.1
