# Troubleshooting

Start with `sh scripts/setup.sh --check` from the repository root. It checks local build prerequisites without signing in or connecting to a game.

| Symptom | What to do |
| --- | --- |
| Git says “Repository not found” | This repo is private. Check the invitation and the GitHub account used by Git; the owner must grant access. |
| Missing `swiftc`, `xcrun` or developer directory error | Complete `xcode-select --install`, reopen Terminal and rerun the check. |
| Wrong architecture or Rosetta message | Use an Apple Silicon Mac, a native Terminal and an arm64 Node installation. Intel Mac packaging is not validated. |
| Java compiler/runtime missing | Launch Minecraft Java 1.21.4 or 26.2 once, then rebuild. Simply downloading Launcher is insufficient. The current helper looks for Launcher's arm64 epsilon/delta runtime. |
| Node missing or too old | Install arm64 Node.js 22+ and reopen Terminal. Keep Node installed for a development build. |
| Dependency install fails | Check internet access to the npm registry and retry setup. Keep the committed lockfile; do not replace versions just to bypass an install failure. |
| Swift SDK/compiler mismatch | Update Apple's command-line tools together; avoid mixing `swiftc` from one toolchain with another SDK. |
| Portable build rejects Node libraries or its license | Use the official arm64 Node tar distribution with its adjacent LICENSE. The development build supports an ordinary Node install. See [packaging](../companion/PACKAGING.md). |
| The source app opens the lab route | An existing `harness/.env` opts into the developer lab. Choose a saved connection in **Agent connection**, or use a fresh checkout for normal first-run setup. |
| Model list empty or CLI unavailable | Sign in to the chosen official CLI using its subscription, reopen SoulStone and refresh models. For shell-only installs, launch the executable from Terminal as described in [setup](SETUP.md). |
| Selected model unavailable | Pick one returned by your account's model list. A model ID saved on another machine does not grant access. |
| Connection refused or timed out | Keep Minecraft's LAN world open; recheck the displayed port, host address and local-network/firewall settings. A different Mac needs the host's reachable address, not `localhost`. |
| “Unsupported” or version mismatch | Use `auto`, confirm the server's actual Java release and read [supported scope](STATUS.md). A newer version or modpack is not guaranteed. |
| Microsoft code expired | Start **Link Minecraft account** again and complete the new code before its countdown ends. |
| No Java player profile | Verify the signed-in Microsoft account has Java access and has completed its Java player-name setup in Minecraft. An Xbox gamertag alone is not the Java profile. Then relink. |
| Already connected / duplicate identity | Use a separate Java identity to play alongside the bot. The same identity cannot be the human LAN host and bot in that world. |
| Newly created Java profile rejected | SoulStone retries the specific stale-session rejection once. If it still fails, reconnect or relink the account after confirming the Java profile. |
| Agent appears but does not act | Check model readiness, selected identity, task blocker and actual inventory. A paused request needs **Resume task** when offered. **Stop bot** cancels the request. |
| Source app fails after moving folders or updating Node | Rerun setup from the new checkout so `development.json` records current paths. |
| Voice unavailable | Use text. For voice, grant microphone/speech permissions and use supported on-device English recognition. Text setup does not prove voice works. |

## Diagnostic files

Each saved world has its own directory under `~/Library/Application Support/Vibrant Soul/worlds/`. Its `state/companion-service.log` holds startup/backend diagnostics. These logs and `state/companion-api.json` are private; the latter contains a local API token. Account caches are private too. Share a redacted error, never an entire profile or credential file.

For a useful report include the macOS version/chip, Node version, SoulStone bundle/source version, Minecraft Java/server version, exact request, visible error, and what happened after Stop or Resume. Mention any developer intervention. Never count a repaired test run as an uninterrupted acceptance.

## Recover without discarding history

Use **Disconnect agent** to leave the server while retaining the linked account and world data. **Sign out & unlink** removes that account's cached login and world associations after confirmation; it preserves world history. **Remove saved connection** hides a connection after confirmation while preserving its local history and actual Minecraft world. Do not delete Application Support as a general troubleshooting step.
