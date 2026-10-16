# @fungi.computer/oyster

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
