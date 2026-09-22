# Upgrading Minecraft compatibility

SoulStone has two connection routes. Mineflayer handles the client versions in its installed package. Newer servers use a pinned ViaProxy bundle to translate to a Mineflayer client. Server reachability, a translation path, and successful gameplay are separate checks.

`harness/bridge/compatibility.json` is the single pin for the bridge release, binary and source SHA-256 checksums, client protocol, and supported server versions. Setup, compilation, connection checks and launch read that pin. Adding a newer route preserves older routes; the runtime chooses the server version it actually detected. Unknown protocols remain blocked before account authentication.

## Check upstream

From the repository root:

```sh
python3 scripts/compatibility.py check
```

This reads the installed source pin and latest stable official ViaProxy release. It does not download or execute a candidate, install an app, change world profiles, or schedule future checks. A newer release alone does not prove that it supports the target Minecraft version.

## Stage a candidate

Use the version and protocol advertised by the server. For Minecraft 26.3, the server advertises protocol 777:

```sh
python3 scripts/compatibility.py stage --target 26.3 --protocol 777 --output .local/compatibility-26.3
```

The output directory must be new. An optional `--tag vX.Y.Z` selects a specific stable release. Staging downloads the official Java release asset, checks its GitHub SHA-256 digest, preserves matching upstream source and license, and compiles SoulStone's adapter. It starts a temporary helper for **every previously supported route plus the requested route**. Each helper verifies the actual ViaVersion/ViaBackwards protocol path before reporting ready. Listeners bind to loopback; no player connects, no account is read, and no model is called. Upstream helper startup may perform its own public update checks.

The candidate is isolated from the active source pin and installed app. Its `receipt.json` reports `translation-verified` or `blocked`, retains failure details, and marks gameplay as untested. A blocked candidate cannot be applied. Do not make an unsupported server look compatible by changing only its protocol number or by adding an unverified manifest entry.

## Adopt and validate

Inspect the candidate receipt, release notes and changes before adopting it:

```sh
python3 scripts/compatibility.py apply .local/compatibility-26.3
npm --prefix harness test
python3 companion/scripts/test_bridge_upgrade.py
python3 companion/scripts/build-bridge.py --probe
python3 companion/scripts/build.py
python3 companion/scripts/build.py --portable
python3 companion/scripts/smoke-package.py
```

Adoption verifies the candidate is unchanged and the repository pin still matches the staging baseline, recompiles the adapter, and repeats all translation checks. It copies versioned artifacts before atomically replacing the active manifest. Old artifacts remain for rollback. It changes source only; it does not install or launch the app. Review binary, source, license and manifest changes together. Test setup and packaging from a clean export before publishing the upgrade.

Install the validated app with the normal project approval process, preserving `Vibrant Soul` account/world data. In a disposable world on the new version, test sign-in, spawn and chunks, movement, inventory, crafting, placing/breaking blocks, reconnect and Stop. Then perform a bounded gameplay run and compare progression and failures. Passing the translation probe does not establish correctness of new blocks, entities, recipes, combat mechanics or survival.

## Rollback

Keep the prior app and compatibility manifest until the new version has live acceptance. Restore the prior source pin and source revision, rebuild, and reinstall the prior app if necessary. Versioned bridge artifacts are retained so source rollback does not need a new download. A source rollback does not downgrade Minecraft world data; use the appropriate pre-upgrade world backup for older Minecraft versions.

## Current 26.3 boundary

At this change's verification, the public ViaProxy 3.4.12 / ViaVersion 5.11.0 family supports 26.2, and the public protocol implementation does not include 26.3. The staging command rejects 26.3 and leaves it disabled. Re-run the same workflow when a compatible upstream release becomes available. This document is not a claim that 26.3 gameplay passed.
