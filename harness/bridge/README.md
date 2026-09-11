ViaProxy 3.4.12, source commit 16c9b7b.
Source: https://github.com/ViaVersion/ViaProxy/tree/16c9b7b
Upstream license: ViaProxy-LICENSE.
Matching upstream source/build files: ViaProxy-3.4.12-source.zip.
SoulStone adapter source and metadata: source/ (canonical workspace: companion/bridge/).
Microsoft credentials are never passed to this helper.
Rebuild adapter in the workspace: python3 companion/scripts/build-bridge.py
Standalone adapter compilation: javac -proc:none --release 17 -cp ViaProxy-3.4.12.jar -d classes source/*.java
The build script supplies the launcher/plugin manifest and packages the compiled classes.
The installed Minecraft Launcher Java runtime is discovered automatically on Apple Silicon macOS.
