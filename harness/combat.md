# SoulStone basic self-defense

The requested prerequisite for supervised play now passes a bounded live check. Self-defense uses the shared executor and does not wait for a model response. All selected providers use the same controller.

## Current behavior

When a potential hostile interrupts work or following, the controller evaluates whether to fight. It can engage one zombie, husk or spider within six blocks when health is at least 14/20, food at least 10/20, no other potential threat is within eight blocks, the target is identified and visible, and a serviceable stone/iron/diamond/netherite axe or sword is carried. It equips the selected weapon and a carried shield when supported. It does not grant or automatically craft combat equipment.

The action spaces attacks, checks sight and range before striking, and limits pursuit to eight blocks and 30 seconds. It does not dig, build scaffolding or target players/neutral mobs. Sword attacks are refused near bystanders. Low health/food, additional threats, lost contact, depleted weapons or unsupported enemies cause a shelter attempt. An unavailable shelter remains an explicit failure.

Stop cancels movement, attack dispatch and shield use. Disappearance, a reused entity ID or reconnect never counts as a kill. A successful action records observed server death after attacks; server statistics are needed for exclusive kill attribution. After two clear seconds it resumes following, or replans an interrupted task with its original request ID. Automatic task continuation is capped at three combat interruptions per request and refuses uncertain inventory effects.

This is close-range self-defense. Player protection, PvP, ranged combat, creeper handling, groups, bosses and general hunting remain unfinished. Live verification covers Java 1.21.4. Armor management and shield damage-blocking statistics were not acceptance criteria.

## Live acceptance

Accepted run: `results/combat-live-1789048722115/`. Normal difficulty, active AI, natural spawning disabled, one mob at a time on the existing lab's reserved pad. A temporary roof prevented sunlight damage. The test bot received an iron axe and shield, started each encounter at full health/food, and was following the spectator witness before the mob appeared. No model call or operator rescue occurred during the three completed fights.

| Encounter | Result | Attack / hurt events | Minimum health | Encounter and continuation time |
| --- | --- | --- | --- | --- |
| Husk | Server kill credited; following resumed | 3 / 3 | 17/20 | 8.673 s |
| Zombie | Server kill credited; following resumed | 3 / 3 | 20/20 | 9.264 s |
| Spider | Server kill credited; following resumed | 2 / 2 | 20/20 | 7.846 s |
| Stop during husk fight | Cancelled after first attack; target still alive | Attacks stayed at 1 | 20/20 before Stop | 5.694 s total |

The Stop case observed no further attack after cancellation and a further 1.2-second wait; the server kill count stayed zero. Cleanup removed that tagged mob after the check. Every successful fight retained its connection and dispatched no retreat. Each kill was independently confirmed using a temporary server statistic objective, in addition to the bot's death observation.

The temporary floor, roof, mobs and scoreboard objectives were removed. Peaceful difficulty, disabled spawning/daylight cycling and time 6000 were restored. The main companion retained its connection, inventory, project memory and request identity throughout the fixture run. These short supplied-equipment encounters do not establish indefinite combat survival or survival without a base.

The first attempt, `results/combat-live-1789048640507/`, failed before attacking because the entity guard accepted the older `mob` classification but not this version's `hostile` classification. It selected shelter, which the isolated fixture did not provide. Cleanup passed. The guard now recognizes both protocol representations while retaining the positive mob-name allowlist; tests use the installed registry's actual entity classification and also check nearby animal/player protection.

## Verification and delivery

The complete suite passes 261 tests (`results/combat-full-tests.txt`). Eleven combat checks cover selection, bystanders, attack cadence, observed death, Stop during equipment/shield use, disappearing/reused targets, changing threats/health, reconnect refusal, automatic continuation and restored following. Existing retreat/recovery checks continue to pass.

All runtime files stayed fixed during the accepted live run. Afterward, one stale sentence in `src/companion/goal-prompt.txt` was corrected to acknowledge automatic melee defense; that prompt was not used by the no-model combat fixture. The combat executor and supervisor remain the accepted versions.

Next is the [app-only play session](../companion/PLAY-SESSION.md). Further combat expansion stays in the backlog unless ordinary play exposes a blocking failure.

Implementation uses the installed Mineflayer attack, equipment and entity-event interfaces; [upstream API reference](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md#botattackentity-swing--true).
