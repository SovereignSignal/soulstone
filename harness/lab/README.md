# The lab

SoulStone is tested in a **test world** before anything reaches the world people play in. Every change runs there first, and so does every first-ever capability (the first Nether trip, the first fortress). The test world is a Paper server in Docker; the bot connects through a ViaProxy bridge, because the harness speaks Minecraft 1.21.4 and the servers run newer releases. As of October 2026 the lab and the family world each run on a Raspberry Pi 4 (4 GB), with the bot and the server on the same Pi.

## What is here

| File | What it does |
|---|---|
| `bridge.js` | The ViaProxy launcher. Reads the pinned release and supported server versions from `../bridge/compatibility.json`, so one launcher serves every route. Settings are environment variables documented at its top: `MC_TARGET_VERSION` picks the route (26.2 or 26.3). |
| `compose.example.yml` | A test-world server as the lab runs it. RCON stays inside the container. The password and seed go in a private `.env`. |
| `nether-scan.mjs` | Reads a world's Nether region files and lists blaze spawners and structure starts, nearest first. `/locate` can be wrong after a world converts between versions; the blocks are not. |
| `staging/` | The blaze-rod experiments (below). |

## Staged runs (`staging/`)

These set up a situation in the test world by console, post one request to the bot, and watch it. **Test world only.** They teleport the bot, give it kit and summon mobs, which would be cheating in a world people play in.

- `reset-fortress.sh`: clears what earlier runs left at the lab's Nether portal: the bot's cobblestone, loose items, hoglins, magma cubes, zombies and skeletons nearby. It keeps the three blazes nearest the portal.
- `blaze-range.sh <log> [minutes] [max] [hoglins]`: a practice range. While the bot is on the fortress bridge and no blaze is over the deck, it summons one, at most one a minute.
- `stage-fortress.sh <run-name> [minutes]`: teleports the bot beside the Nether portal with a bow kit, then posts `REQUEST` (default: shoot blazes and bring 3 rods home) through the watcher.
- `watch.py <out-dir> <minutes> <request> [--allow-nether]`: posts one request, samples the bot's state every second, and ends on a death, a finished request or the time limit. It writes `watch.jsonl` and a report.
- `alert.py <run.out> <since-iso>`: waits for a death, a stall in shelter, a give-up or the run's end.
- `rod-watch.sh`: logs blaze rods lying near the bridge, to tell "no drop" from "dropped and lost".

The Nether coordinates in these scripts (portal at -70,61,-41, the bridge, a blaze spawner at -35,58,-8) belong to the lab world. Another world needs its own, and `nether-scan.mjs` finds them. Settings come from the environment, with the lab's values as defaults:

| Variable | Meaning | Default |
|---|---|---|
| `MC_CONTAINER` | the test world's container | `mc-sandbox` |
| `MC_BOT` | the bot's player name | `SoulStone303` |
| `SOULSTONE_ROOT` | the install (harness, run) | `~/soulstone` |
| `SOULSTONE_RUN` | the bot's run folder (its state and API) | `$SOULSTONE_ROOT/run` |
| `LAB_OUT` | where runs are written | `$SOULSTONE_ROOT/harness/results/lab-runs` |

`--allow-nether` is refused unless `SOULSTONE_RUN` is the test bot's own run folder. Portal travel into the Nether is off for any bot until its owner turns it on.

## What the Raspberry Pi taught (13 October 2026)

Moving the lab from a fast x86 VM to a Pi 4 exposed freezes the VM had hidden. The bot's whole process stopped for 5 to 40 seconds in block scans (mineflayer's `findBlocks` builds a block for every cell of a one-block section, sky included) and in the threat-route search. Each one got the bot killed at least once. They were found by profiling the live bot (`node --cpu-prof` through the service's environment) and fixed so the answers stay identical.

Two more things to keep in mind on a Pi:
- **Never leave chunks force-loaded.** 47 force-loaded chunks held a Pi server at 5 TPS.
- **Leave the watcher's API timeout at 15 s or more.** A Pi can stall briefly.

## The older lab suites

`npm run test:lab` (`test/lab-integration.js`) and the `test/*-lab.js` scripts drive a disposable server named by `MC_HOST` and `MC_SSH_HOST` in the ignored `.env`. `MC_LAB_EXPERIMENT=yes` authorises their fixture edits, kicks and kills of their own test players only. They predate the staged runs above and test navigation, recovery, building and items on a flat platform fixture.
