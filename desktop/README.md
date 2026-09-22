# SoulStone Play desktop preview

Windows-first desktop port around the existing SoulStone harness. An unsigned Windows x64 NSIS test installer has been cross-built on macOS; installation, first launch, speech-helper startup and clean shutdown passed in a Windows 11 ARM VM. Gameplay acceptance remains pending. The child view has Play, Talk and Stop, spoken replies, optional text, a backpack and explicit recovery controls. F8 toggles recording and sends on the second press; F9 stops. Shortcuts work while another app has focus when the OS permits registration. Parent setup owns world, account and model configuration.

This is a development preview. Native x64-PC testing and a real child voice/play session still require acceptance. The ARM VM runs the x64 app through Windows emulation. The existing native Mac app remains available separately.

## Parent setup

Use Minecraft **Java Edition**, a separate Java identity for the teammate, and an adult-managed Codex/ChatGPT or Claude subscription. The selected provider's official native CLI must already be installed and signed in. Its model allowance is used when the child sends requests. SoulStone does not purchase access or fall back to a paid API. The child does not need Git, Python, Node, a terminal, or model settings during normal play.

Open Grown-up setup. Name the world, enter her Java player name and the LAN host/port, link the teammate's account, check available models, then test her microphone and spoken reply. Save. Open the Java world to LAN and press Play. Use Find open LAN worlds during parent setup to remember the selected broadcast. Play listens briefly for exactly one matching host and world label, allowing its port to change. A different host, changed world label or ambiguous broadcast asks for parent help. Manually entered connections still need their LAN port updated when it changes. LAN discovery itself needs a real Windows network acceptance check. The setup screen is a simpler workflow, not a parental security lock or spending limit.

F8: press, speak, press again to send. Recording ends after 20 seconds. F9 and Stop cancel recording and stop the agent. Low-confidence or empty Windows recognition is not submitted. Sound can be muted. Closing the window disconnects the agent and closes owned helpers. Respawn is explicit and warns that inventory may remain where the agent died.

Windows recognition uses System.Speech and installed speech languages. Short English button phrases supplement free-form dictation; the existing confidence threshold still applies. No cloud transcription account or API key is required. Missing language or microphone access blocks voice readiness and is reported to the parent. Recognition accuracy for a seven-year-old remains a real-device acceptance requirement. Mac uses Apple Speech/AVFoundation; Apple's speech service may process audio depending on its configuration.

App data uses the platform's Electron user-data directory for **SoulStone Play**, separate from the native Mac app. Different worlds need separate world identities. A changing port retains the same world identity; checking “different world” creates a new identity and preserves the earlier world's files. Updates and uninstall must preserve app data.

## Development and packaging

Install locked harness dependencies, then desktop dependencies:

```sh
cd harness
npm ci
cd ../desktop
npm ci
npm test
npm run prepare:resources
npm start
```

Resource preparation needs a JDK 17+ (JAVA_HOME or Minecraft Launcher's Mac JDK), npm, and platform build tools. Building on Windows needs the .NET Framework C# compiler and System.Speech; cross-building the Windows helper on macOS needs a .NET SDK and the pinned Microsoft .NET Framework reference assemblies; macOS needs Apple command-line tools. Resources are assembled from an explicit source allowlist, a fresh production dependency installation and the integrity-checked compatibility bridge. Runtime state, account caches, .env, test receipts and model weights are excluded.

Build an internal Windows x64 installer on Windows:

```sh
npm run dist:win
```

To cross-build on macOS, install a .NET SDK for the build machine and make `dotnet` available on PATH, or set `SOULSTONE_DOTNET` to its executable, then use the same `npm run dist:win` command. The build compiles an x64 .NET Framework 4.8 voice helper. The Windows PC needs the .NET Framework 4.8 runtime and an installed speech recognizer; it does not need the SDK.

The per-user installer bundles Electron's Node runtime, harness dependencies, native voice helper and Minecraft protocol bridge. Minecraft's own Java runtime is reused. A bundled Java runtime can be selected using MC_JAVA_HOME in the service environment; no runtime download occurs automatically. Official provider CLIs are currently a parent-installed prerequisite. Distribution signing, notarization and automatic updates are not configured. No publishing happens from these scripts.

For a separate Apple Silicon desktop preview:

```sh
npm run dist:mac
```

Before giving the Windows build to a child, verify on a standard Windows user account: install from a clean source build; first run without developer tools; Microsoft linking; provider readiness; microphone/language setup; her voice understood and replies audible; F8/F9 with Minecraft focused; one task; Stop during thought and movement; leave/quit; restart; LAN-port change; no leftover bot/Java/provider/voice processes; preserved world state after update. Test missing microphone, denied permissions, sign-in expiration, unsupported Minecraft version and disconnected world.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut), [Windows speech engine](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine?view=netframework-4.8.1).

## Windows speech diagnostic

Run the synthetic-audio acceptance fixture on Windows with an installed en-US speech recognizer and desktop TTS voices:

```powershell
.\scripts\test-windows-voice.ps1
.\scripts\test-windows-voice.ps1 -Baseline
```

This compiles the actual recognizer factory with a test entry point, synthesizes short requests and similar-sounding alternatives, then recognizes the WAV files without using a microphone. It retains audio for inspection and returns a failing exit code when a phrase is wrong, low-confidence or missed, or an unrelated phrase is promoted to a button command. It is separate from the JavaScript regression suite.

The Windows ARM VM passed all 18 JavaScript desktop/platform checks and a real owned-process tree shutdown check. The speech fixture improved from 8/18 to 13/18 checks after adding the English phrases. David passed all nine cases; Zira still failed five of six intended commands. A 16 kHz diagnostic variant improved the fixture to 15/18, which still does not establish child speech accuracy. These retained failures prevent a voice-ready release claim. No microphone, account, game or model was used by these diagnostics.
