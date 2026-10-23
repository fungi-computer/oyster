#!/usr/bin/env bash
export PATH=/home/levi/Botanical-cto/lanes/bin:$PATH
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
pin=$(tooling/celld-platform/runtime/pinned-celld.sh)
node_path=$(command -v node)

# Same native runtime/private-network primitives as Hub's boot proof.
# No running host service is used.
exec sudo -n unshare --net bash -c '
export PATH=/home/levi/Botanical-cto/lanes/bin:$PATH
set -euo pipefail
ip link set lo up
cd packages/oyster
exec setpriv --reuid="$5" --regid="$6" --init-groups env -i \
  PATH="$4" HOME="$7" CELLD_PLATFORM_CELLD="$1" PLAYWRIGHT_BROWSERS_PATH="$2" \
  WRANGLER_SEND_METRICS=false \
  "$3" --import tsx \
  --import ../../tooling/celld-platform/runtime/wrangler-on-celld.mjs \
  test/grant-consent.native.mjs
' grant-consent-proof "$pin" "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" "$node_path" "$PATH" "$(id -u)" "$(id -g)" "$HOME"
