The active ViaProxy release, checksums and supported server routes are pinned in compatibility.json.
Upstream: https://github.com/ViaVersion/ViaProxy
Upstream license: ViaProxy-LICENSE. The matching source archive is named in the manifest.
SoulStone adapter source and metadata: source/ (canonical source: companion/bridge/).
Microsoft credentials are never passed to this helper.
Build and check every pinned translation path: python3 companion/scripts/build-bridge.py --probe
The generated adapter is versioned alongside ViaProxy and is not committed.
Upgrade workflow: docs/COMPATIBILITY.md at the repository root.
The installed Minecraft Launcher Java runtime is discovered automatically on Apple Silicon macOS.
