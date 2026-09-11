# Portable macOS packaging

Normal source installation is covered by [setup](../docs/SETUP.md). A portable build includes the native app, Node, harness, installed JavaScript dependencies and compatibility helper. It has no checkout reference and keeps user state outside the app bundle.

## Build prerequisites

Use an Apple Silicon Mac with the source-build prerequisites. For portable packaging, Node must have no non-system dynamic-library dependencies and its distribution LICENSE must be available next to its `bin/` directory. The official arm64 **tar distribution** provides that layout. A package-manager Node can depend on external libraries, and a package installer may not retain the required LICENSE at that path.

Download an arm64 Node.js 22+ tar distribution from [Node.js](https://nodejs.org/en/download), verify it using the distribution's checksums, extract it and use its `bin` directory first in `PATH`. The setup checker confirms architecture/version; packaging additionally verifies library dependencies and the LICENSE. Do not use a copied Node binary without its license.

The app compiles with an explicit macOS 14 deployment target matching its plist. That makes the build metadata consistent; a second Mac/older-OS gameplay run is still required for runtime acceptance. An included Node runtime or Java/provider dependency can impose its own platform requirements.

## Build and check

From the repository root, with the packaging Node selected:

```sh
sh scripts/setup.sh --portable
python3 companion/scripts/smoke-package.py
```

Output: `companion/build/portable/SoulStone.app`. The smoke check copies the bundle to an isolated directory, starts the backend with an empty profile, verifies API authentication and file permissions, and checks signatures. It does not sign in, join Minecraft or call a model.

The bundle includes `src/`, `node_modules/`, `bridge/`, package metadata and artwork. It excludes `.env`, world/account state, model keys, raw results and local model weights. The pinned ViaProxy binary must be accompanied by its source archive and license; the generated adapter includes its corresponding source in the package.

## Install or share a build

Quit any running SoulStone copy before replacing an installed one. In Finder, copy the portable `SoulStone.app` to the recipient's Applications folder. Keep a recoverable prior bundle when updating. Open that installed copy and configure the recipient's own world, Minecraft account and reasoning provider. Keep only one SoulStone copy running.

The receiving Mac does not need the source checkout or a separate Node install. It still needs Minecraft Launcher and its Java runtime, plus the chosen provider CLI and account access. Preserve `~/Library/Application Support/Vibrant Soul/` across app updates.

To prepare a local distribution archive:

```sh
ditto -c -k --sequesterRsrc --keepParent   companion/build/portable/SoulStone.app   companion/build/SoulStone-macOS-arm64.zip
shasum -a 256 companion/build/SoulStone-macOS-arm64.zip
```

The build is ad-hoc signed. Developer ID signing and notarization are not implemented, so downloaded copies may encounter macOS security prompts. A polished downloadable installer and GitHub Release must not be assumed from the existence of a local archive. Test the recipient's install, sign-in, connection and small gameplay task before calling distribution ready.

## Release checks

Run regressions, the portable smoke check and signature verification. Inspect the actual Mach-O minimum OS and architecture, preserve the exact source revision, and confirm no private profile/state is bundled. Verify installation and account linking on another Mac, use two identities for simultaneous LAN play, and check one task, Stop and reconnect. Source compilation alone does not complete those checks.
