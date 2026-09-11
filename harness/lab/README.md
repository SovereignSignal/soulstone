# Existing disposable lab

Sov confirmed the existing Proxmox Minecraft server is for experiments and may be broken, reset and rebuilt. No second instance is needed or deployed.

## Checkpoint

The server was stopped before a full snapshot of server-data, Compose configuration and private environment settings. The snapshot stays on the VM, outside source control, with root-only access because it includes private configuration.

- Snapshot: `snapshots/pre-harness-20260907.tar.gz` beneath the existing deployment directory.
- SHA-256: `9f47be655967111e900b2babd1319bb155125b341410b63a97f6099d1a3bfe4a`.
- Original ControlBot source archived locally at `baseline/control-source.tar.gz`.
- Source archive SHA-256: `e38b767ce46878a62a93edf23ce73985323cb028a7eb9c06c00fb65424598591`.

RCON is enabled with a generated private password. No RCON port is published. The evaluator executes `rcon-cli` inside the existing container through SSH. Credentials are never passed to the bot or model.

## Platform fixture v1

- Existing world, Paper 1.21.4. Smooth-stone floor: x=0…100, y=250, z=0…16. Air above: y=251…255.
- Start: (2.5, 251, 8.5). Navigation destination: (22.5, 251, 8.5). Recovery destination: (80.5, 251, 8.5).
- Peaceful difficulty, noon, clear weather, daylight/weather cycles and mob spawning disabled. Spawn radius zero. Platform chunks force-loaded.
- Test bot: HarnessRunner, whitelisted, survival mode, empty inventory, restored health, fixed respawn point.
- Navigation cannot dig, place scaffolding, tower, parkour or sprint.
- Reset stops the bot, clears its inventory, restores survival/health/respawn and teleports it to the start. Position is independently queried through RCON.
- Completion must occur within 60 seconds and server position must be within three blocks. Runner aims for two blocks or closer.

The suite intentionally leaves this fixture in place. It affects global difficulty, world spawn and the listed gamerules. This is a navigation/recovery baseline, not T6. Establish a hard-survival fixture before scoring survival. Full-world restoration and a fixed-seed resource benchmark remain untested.

## Run

Set private MC_HOST and MC_SSH_HOST in the ignored `.env`. Then:

```sh
MC_LAB_EXPERIMENT=yes npm run test:lab
```

The explicit flag authorizes fixture edits, kicks and killing only HarnessRunner. The suite also kills its local runner process to test durability. It writes a timestamped report and stops its bot when finished. The Minecraft server stays available for further experiments.

Tests: three baseline joins, T2 navigation, T7 actual kick/resume, process kill/restart, stop across reconnect/restart, death with explicit resume, and task deadline. T1 and T3–T6 remain untested.

For restore: stop the lab; verify the archive checksum; preserve the current directory as a separate checkpoint; restore server-data into an empty target directory and deliberately choose whether to restore the old config (which disables RCON); start and health-check. Do not overlay extracted world files on an existing world. An executable restore workflow has not yet been validated.
