# Install and run SoulStone

This guide starts from a fresh clone on an Apple Silicon Mac. It does not depend on the project's private lab, saved state, local model weights or owner archive. For current coverage, read [support and limits](STATUS.md).

## Prerequisites

| Requirement | How to prepare |
| --- | --- |
| Repository access | The repository is public. Clone it over HTTPS or SSH with your normal Git setup. |
| Apple Silicon Mac | About This Mac should list an Apple chip. Use a native Terminal session. The native build targets macOS 14+. |
| Apple command-line tools | Run `xcode-select --install`, complete Apple's installer, then reopen Terminal. Full Xcode is optional. |
| Python 3.9+ | Check `python3 --version`; install a current [Python for macOS](https://www.python.org/downloads/macos/) if needed. |
| Node.js 22+ and npm | Install an arm64 release from [Node.js](https://nodejs.org/en/download). Check `node --version` and `npm --version`. No global SoulStone npm package is needed. |
| Minecraft Java | Install [Minecraft Launcher](https://www.minecraft.net/en-us/download) and launch Java 1.21.4 or 26.2 once. This supplies the compiler/runtime used by SoulStone's compatibility helper. Bedrock does not work. |
| Reasoning provider | Install Codex CLI or Claude Code and sign in with the corresponding subscription. This is needed for model-backed tasks, not compilation. |

You do not need Docker, a Proxmox server, a VPN, a local LLM download, an API key or a paid Apple developer membership to build the source app.

## Clone, check and build

Run these commands in the folder where you keep code:

```sh
git clone https://github.com/SovereignSignal/soulstone.git
cd soulstone
sh scripts/setup.sh --check
sh scripts/setup.sh
open companion/build/SoulStone.app
```

`--check` reports missing prerequisites without installing anything. Normal setup runs `npm ci --ignore-scripts` against the committed lockfile, verifies the pinned ViaProxy helper, compiles the Java adapter and builds/signs the native app locally. The first dependency install needs internet access. The script stops on failure with a useful next step.

Successful output ends with `Ready. Run: open companion/build/SoulStone.app`. The app opens **World connections** on a fresh profile. Do not create `harness/.env` for normal app setup: that file opts a development build into the optional private-lab route.

This build records the checkout and Node locations. Keep them in place and launch the same app copy each time. You can open it from Finder or keep it in the Dock. [Portable packaging](../companion/PACKAGING.md) creates a build that can move independently of the source checkout.

## Reasoning provider

Choose one provider. You do not need to set up both. SoulStone's subscription profiles require subscription sign-in and do not silently fall back to a billed API account. Provider availability and your plan determine which models can be selected.

### Codex with ChatGPT

Install Codex using the [official CLI instructions](https://learn.chatgpt.com/docs/codex/cli), then run:

```sh
codex login
codex login status
```

Complete **Sign in with ChatGPT** in the browser. The status should report ChatGPT sign-in, not API-key authentication. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth) for the official distinction. In SoulStone, choose **Codex subscription**, refresh the model list and select a model available to your account. If the default model is unavailable, select an available one rather than leaving the default unchanged.

### Claude Code

Install Claude Code from its [official setup guide](https://code.claude.com/docs/en/setup), then use its subscription login:

```sh
claude auth login
claude auth status
```

In SoulStone, choose **Claude subscription** and refresh the model list. Use a Claude subscription login for this profile. API/local profiles can be added later through **Models**.

### When the app cannot find an installed CLI

Reopen SoulStone after installation. It checks the standard application, `~/.local/bin`, Homebrew and `/usr/local/bin` locations, then absolute directories in the inherited `PATH`. If you use a shell-only version manager, Finder may not have that path. Launch the built executable from that configured Terminal:

```sh
./companion/build/SoulStone.app/Contents/MacOS/MinecraftTeammate
```

## First world

For the shortest path, use a disposable Minecraft Java world on the same Mac, set it to Peaceful and open it to LAN. Copy the port Minecraft prints; it can change each time you open the world.

In **World connections**:

1. Choose **LAN on this Mac**. Enter the displayed port and a connection name.
2. Leave version on `auto` and click **Check connection**. Confirm the result describes the server you opened.
3. Enter **Your Java player name**, exactly as it appears in Minecraft.
4. Choose **Linked Minecraft account**, click **Link Minecraft account**, finish the Microsoft device-code flow, and verify the resulting Java name.
5. Select the subscription provider and a discovered model. **Save connection** stores a draft; **Connect agent** requires complete settings and joins the game.

For two players in one world, the human and bot must use distinct Java identities. If your human account hosts the LAN world, give SoulStone a different account with Java access. A solo bot may reuse a normal player account if that identity is not currently connected to that server. [Connections](../companion/CONNECTIONS.md) covers other hosts and dedicated servers.

Wait for **connected** game status and model readiness. Ask what the bot is carrying, then try one small collection request. Inspect the result in the app and Minecraft. A build success or green server ping alone does not establish gameplay success.

## Updates and recovery

Quit SoulStone before updating, and keep one app copy in use. Preserve local changes before pulling; inspect `git status` first. From a clean checkout on the normal branch:

```sh
git status
git pull --ff-only
sh scripts/setup.sh
open companion/build/SoulStone.app
```

Saved connections, accounts and world history remain in `~/Library/Application Support/Vibrant Soul/`. Do not delete that folder during an update. Reopening the same world profile preserves its context; a new Minecraft world or reset needs a new connection profile. If you move the checkout, rebuild from its new location.

If setup fails, use [troubleshooting](TROUBLESHOOTING.md) with the exact failure. The next person should be able to reproduce the build before attempting account sign-in or gameplay.
