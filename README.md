# SoulStone

A Minecraft teammate for macOS. Give it a goal in text or voice, follow its progress, inspect its inventory and stop it from a native app. SoulStone can gather, craft, build, manage base supplies and explore through a bounded Mineflayer harness.

**Current alpha: Apple Silicon Mac, macOS 14+ build target, Minecraft Java.** Gameplay has scoped checks on Java 1.21.4 and 26.2. Windows, Linux, Intel Mac, Bedrock and modpacks are not validated app targets. See [support and limits](docs/STATUS.md).

## Quick start from source

You need access to this private repository, Apple command-line tools, Python 3.9+, an arm64 Node.js release version 22+, and Minecraft Launcher. **Launch Minecraft Java 1.21.4 or 26.2 once** so its Java runtime is installed. The [setup guide](docs/SETUP.md) has prerequisite instructions.

```sh
git clone https://github.com/SovereignSignal/soulstone.git
cd soulstone
sh scripts/setup.sh
open companion/build/SoulStone.app
```

Setup checks your prerequisites, installs the pinned JavaScript dependencies and builds the app. It does not sign you in, join Minecraft or request a model response. A fresh checkout opens **World connections** for your own setup. No `.env`, private lab access or owner archive is needed for this path.

This source build uses the checkout and your installed Node runtime. Keep both where they are. Run the setup command again after moving the checkout or changing Node's location. For a self-contained app, see [portable packaging](companion/PACKAGING.md).

## Connect your world and model

1. Install and sign in to the **Codex CLI with ChatGPT**, or **Claude Code with a Claude subscription**. Select a model available to your account in SoulStone. The [setup guide](docs/SETUP.md#reasoning-provider) includes the login steps. Models use your selected provider's allowance; they are not included with SoulStone.
2. In Minecraft Java, open a world and choose **Open to LAN → Start LAN World**. Keep the world open and note the displayed port.
3. In SoulStone, choose **LAN on this Mac**, enter that port and your Java player name, and click **Check connection**. Leave Java version on `auto`. For another host or a dedicated server, follow [connections](companion/CONNECTIONS.md).
4. Click **Link Minecraft account**, complete the Microsoft sign-in and verify the Java name shown. Playing beside the bot in one world requires two Minecraft identities. A solo bot can use your normal account when that identity is not already playing there.
5. Choose the thinking provider and model, then **Connect agent**. Wait for the app to show the agent connected and the model ready.

Start with:

```text
What are you carrying?
```

Then, in a disposable world with reachable oak trees:

```text
Collect one oak log.
```

Inspect the inventory and try **Stop bot** during work. [First play session](companion/PLAY-SESSION.md) explains success checks and recovery. Start in Peaceful while you learn the controls; broad hostile survival remains unfinished.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Setup](docs/SETUP.md) | Prerequisites, clone/build, provider login, first launch and updates |
| [Connections](companion/CONNECTIONS.md) | LAN, remote servers, Java accounts and saved worlds |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Build failures, missing models, account errors and connection problems |
| [Companion controls](companion/README.md) | Text, voice, Stop, Resume and model selection |
| [Support and limits](docs/STATUS.md) | Tested scope and what remains unverified |
| [Packaging](companion/PACKAGING.md) | Self-contained builds, checks and distribution boundaries |
| [Harness](harness/README.md) | Terminal lab use and implementation details |

## Development

```sh
sh scripts/setup.sh --check
cd harness
npm test
```

The regression suite uses local fixtures. Separate lab scripts can modify a Minecraft world or consume model usage and require their documented opt-in. See [lab fixtures](harness/lab/README.md) and [planner evaluations](harness/eval/README.md).

Code lives in `harness/src/`, native UI in `companion/Sources/`, and the compatibility adapter in `companion/bridge/`. Start with the [goal contract](harness/autonomy.md), [construction](harness/construction.md) and [prospecting](harness/prospecting.md) for implementation context. Contributor guidance is in [AGENTS.md](AGENTS.md).

## Local data and licensing

World history and linked-account data stay under `~/Library/Application Support/Vibrant Soul/`; that legacy folder name is intentional. Model API keys use macOS Keychain. Updating the app should preserve this data. Do not copy another person's profile or credentials into your installation.

Credentials, receipts, weights, generated builds and local history are excluded from Git. Internal plans and dated lab records are maintained separately from this repository; installation and normal development do not require that archive.

Mineflayer and its plugins retain their upstream licenses. The pinned ViaProxy binary is accompanied by its source and license in [harness/bridge](harness/bridge/README.md). This private alpha does not grant an open-source license for SoulStone's original code.
