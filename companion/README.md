# SoulStone companion

Start with the repository [quick start](../README.md) and [setup guide](../docs/SETUP.md). The native app supports text goals, push-to-talk, spoken replies, inventory/progress inspection and immediate cancellation.

## Daily controls

| Control | Behavior |
| --- | --- |
| **Agent connection** | Inspect the selected account/world; connect, disconnect, change world or sign out. |
| **Models** | Select the provider and a discovered model. Explicit API/local profiles can be added here. |
| **Stop bot** | Cancel the current request and physical work. Previously completed actions remain. |
| **Resume task** | Continue a blocked/interrupted request when the app offers it, preserving its identity and verified progress. A stopped request stays cancelled. |
| **Talk / Control-Option-Space** | Start speech capture; press again to send. Requires microphone/speech permissions and supported on-device English recognition. |
| **Voice replies** | Enable macOS speech synthesis for replies. Text remains available. |

Do one small task at a time at first. Watch the goal, progress and blocker explanation. Verify results in the world. The [first play session](PLAY-SESSION.md) gives a short check that includes Stop.

## Connections and data

Use [World connections](CONNECTIONS.md) to save a server/LAN profile and link a Java account. Each world keeps its own requests, buildings, inventory observations and experience. Editing the port for the same world retains that identity. A new world or server reset needs a new profile.

Normal app state uses `~/Library/Application Support/Vibrant Soul/`, including `worlds/` and `accounts/`. The legacy storage name and bundle identifier are intentional. Account caches have restricted local permissions; API keys entered through Models use Keychain. Provider subscription authentication stays with the provider's CLI.

The source build depends on its checkout and installed Node. A [portable build](PACKAGING.md) bundles the backend and Node, but still needs Minecraft's Java runtime and the chosen provider CLI on the receiving Mac. Keep one app copy in use.

## Development

```sh
sh scripts/setup.sh
open companion/build/SoulStone.app
```

On a clean checkout the app opens its setup screen. Maintainers can deliberately create `harness/.env` for the separate offline-lab development path, described in the [harness guide](../harness/README.md). Normal users should configure connections in the app.

See [troubleshooting](../docs/TROUBLESHOOTING.md) and [current limits](../docs/STATUS.md).
