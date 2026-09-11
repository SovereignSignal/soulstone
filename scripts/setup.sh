#!/bin/sh
# Check prerequisites, install locked JS dependencies and build the native app.
set -eu
cd "$(dirname "$0")/.."
mode=${1:-build}
case "$mode" in build|--check|--portable) ;; *) echo "Usage: sh scripts/setup.sh [--check|--portable]" >&2; exit 2 ;; esac
fail() { printf '%s\n' "Setup: $*" "See docs/SETUP.md for installation steps." >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail "The native app currently requires macOS."
[ "$(uname -m)" = arm64 ] || fail "Use an Apple Silicon Mac and a native terminal, not Rosetta."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || fail "macOS 14 or newer is required."
for tool in python3 node npm swiftc xcrun sips iconutil codesign; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. Install the prerequisites first."
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || fail "Python 3.9 or newer is required."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 || process.arch !== "arm64" ? 1 : 0)' || fail "Install an arm64 Node.js release, version 22 or newer."
xcrun --find swiftc >/dev/null 2>&1 || fail "Install Apple command-line tools with xcode-select --install."
python3 - <<'PY'
from pathlib import Path
import hashlib,sys
base=Path.home()/'Library/Application Support/minecraft/runtime'
found=any((base/n/'mac-os-arm64'/n/'jre.bundle/Contents/Home/bin/javac').is_file() for n in ['java-runtime-epsilon','java-runtime-delta'])
if not found:sys.exit('Setup: launch Minecraft Java 1.21.4 or 26.2 once to install its Java runtime, then retry. See docs/SETUP.md.')
jar=Path('harness/bridge/ViaProxy-3.4.12.jar')
if not jar.is_file() or hashlib.sha256(jar.read_bytes()).hexdigest()!='32ce9ad871aeb03286823c29da262ebd75992864e7857db283f103525c7fc0cb':
    sys.exit('Setup: the pinned compatibility helper is missing or changed. Restore it from this repository.')
PY
if [ "$mode" = --check ]; then
    echo 'PASS: native build prerequisites. No installs, account login, game connection or model call.'
    exit 0
fi
echo 'Installing the locked harness dependencies...'
npm --prefix harness ci --ignore-scripts --no-audit --no-fund
if [ "$mode" = --portable ]; then
    python3 companion/scripts/build.py --portable
    echo 'Built companion/build/portable/SoulStone.app. See companion/PACKAGING.md before distributing it.'
else
    python3 companion/scripts/build.py
    echo 'Ready. Run: open companion/build/SoulStone.app'
    echo 'Keep this checkout and Node installed. Configure your world and accounts in the app.'
fi
