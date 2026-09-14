# Minecraft harness lab

Our own Minecraft teammate harness for the existing disposable Paper Java 1.21.4 lab. The native companion uses the selected reasoning provider, with Astra through the Codex subscription currently active. It supports model-planned goals, reusable physical skills, deterministic outcome checks, saved projects and conditional task experience. Local-model work is paused. See [autonomy](autonomy.md), [construction](construction.md) and [current acceptance records: scope and evidence limits](../docs/STATUS.md).

## Play alongside the agent

Join Minecraft directly. `HarnessRunner` is the companion; `HarnessTest` is reserved for evaluator runs. The companion follows its configured owner about three blocks behind and waits if that player leaves its visible area.

In-game commands:

```text
!bot follow
!bot come
!bot status
!bot gather 10
!bot craft pickaxe
!bot stop
!bot resume
!bot help
```

Gathering targets a total of ten oak logs in inventory, not ten additional logs. Crafting targets one wooden pickaxe and makes intermediate planks, sticks and a crafting table as needed. Gathering passed a ten-log server inventory check. The full empty-inventory stone-pickaxe crafting chain subsequently passed independent server checks; failures and fixes remain in the results history. Successful work returns to following if it started in follow mode. After a failure, use follow or issue a new task. Stop cancels work and following.

The companion accepts chat from MC_OWNER only when configured. This is suitable for our whitelisted offline lab; usernames are not secure authentication on public servers. Chat input selects fixed actions and cannot execute code.

Launch one companion process:

```sh
MC_OWNER=YourMinecraftName MC_STATE=state/companion.json npm run play
```

Do not launch a second process with the same Minecraft username. The current companion runs from this Mac and stays connected while that process runs. No browser viewer is used.

Navigation stop stays connected. Interrupting an active gathering/crafting batch disconnects that bot briefly, then reconnects with the goal cancelled. This prevents unfinished library code from continuing a resource-consuming action after stop. Reconnect alone cannot restart cancelled work.

## Use it

Node 22+ required. Dependencies are pinned in the lockfile. The ignored `.env` on this Mac contains the private sandbox connection settings; no credentials are needed for the offline bot.

```sh
npm ci --ignore-scripts
npm start
```

Run from this directory. Send one JSON command per line:

```json
{"action":"navigate","goal":{"x":80.5,"y":251,"z":8.5},"timeoutMs":60000}
```

```json
{"action":"status"}
```

```json
{"action":"stop"}
```

After death, an active task pauses. Explicitly respawn and resume it:

```json
{"action":"resume"}
```

To disconnect while retaining the current task for the next launch:

```json
{"action":"quit"}
```

`stop` cancels durably; `quit`, Ctrl-C and process termination preserve unfinished work. A cancelled task requires a new navigate command. A skill deadline is an idle window that slides on progress up to a hard ceiling; it continues while offline. State belongs to the exact endpoint, username and requested protocol; a different profile cannot silently resume it. Run only one process per state file. Set MC_STATE for a separate agent.

Connection failure uses bounded backoff. The JSON CLI ignores in-game chat by default; companion mode accepts configured-owner commands. Navigation cannot dig or place blocks. Commands and results are local JSON lines; the runner is intended for this private lab, not direct 2b2t operation.

## Verified, 7 September 2026

The first probe joined the old spawn and died. After preparing the fixed platform, the complete movement/recovery suite passed in 168.3 seconds:

| Check | Result | Evidence |
| --- | --- | --- |
| Three baseline joins | Pass | Same start position, five seconds alive each |
| T2 navigation | Pass | Server measured 1.66 blocks from target |
| T7 actual kick/resume | Pass | Same goal completed, 1.57 blocks from target |
| Process killed/restarted | Pass | Saved running goal completed after SIGKILL |
| Stop persistence | Pass | Stationary; cancellation survives kick and process restart |
| Death recovery | Pass | Pauses, explicitly respawns/resumes, completes within 1.68 blocks |
| Deadline | Pass | Unreachable task fails and stops |

Four local validation tests pass. T3 gathering also passed; T4 crafting failed. T1, T5 and T6 remain untested. These are controlled platform results on 1.21.4, not evidence of general terrain capability, hard-night survival, another version, or 2b2t readiness.

```sh
npm test
MC_LAB_EXPERIMENT=yes MC_TEST_USERNAME=HarnessTest npm run test:lab
```

The integration suite intentionally modifies the experimental world and injects failures into the selected evaluator bot. Use HarnessTest while HarnessRunner is online. See [fixture and checkpoint details](lab/README.md). Raw receipts are under `results/`; the report records server-side positions and console acknowledgements. See [results summary: scope and evidence limits](../docs/STATUS.md).

## Files and responsibilities

- `src/runner.js`: connection lifecycle, navigation, durable task transitions and recovery.
- `src/task-store.js`: validated, atomic state writes and profile checks.
- `src/cli.js`: trusted local command interface.
- `src/play.js` and `src/chat-control.js`: live companion and bounded in-game controls.
- `src/skills.js`: inventory-based gathering and wooden-pickaxe crafting.
- `src/probe.js`: bounded connection-only smoke test.
- `test/lab-integration.js`: independent server-side scoring and failure injection.
- `src/burrow.js`, `src/hut.js`, `src/flee.js` and `src/quarry.js`: the emergency burrow and wall-in hut (shelters of last resort), the sprint-away flee used against creepers, and the bounded quarry for cobblestone when no exposed stone is reachable.
- `src/combat.js` and `src/hunt.js`: bounded self-defense against one melee mob with a carried weapon, and hunting farm animals for food or leather.
- `src/armor.js` — wearing the best carried armour.
- `src/travel.js` — crossing real distances in staged legs.
- `src/combat.js` and `src/sleep.js`: bounded self-defense against one melee mob with a carried weapon, and hunting farm animals for food or leather. — bed placement and sleeping through the night.
- `test/live-request.py` and `test/live-sample.py`: drive one request against a running companion service and record before/after state; the sampler also logs five-second rows with health, threats, position and deadline headroom. Both spend model calls and act in the connected world.
- `baseline/`: preserved original ControlBot source, ignored by Git.

The current server is disposable by explicit instruction. It is left in peaceful mode with the fixed platform and internal-only RCON enabled. World/config backup is on the VM. No second server was deployed. Keep baseline capability tests peaceful; later survival tests explicitly enable hard mode and mobs and receive separate scores.

## Next

Resolve the full-chain crafting failure, then validate T1 response and gathering cancellation. Keep the controller replaceable. Add the remaining battery tasks before comparing the five candidates; broaden version coverage and spike ZenithProxy afterward.

[Project hub](https://app.notion.com/p/3c7000c0d59080a4b914d6243ddefcd0) · [Implementation plan: scope and evidence limits](../docs/STATUS.md)
