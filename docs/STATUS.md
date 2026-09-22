# Supported scope and verification

This is an alpha. The repository includes its installation, usage and development guides; private lab access and the owner's archive are not required to build it.

| Area | Current scope |
| --- | --- |
| Native desktop app | Apple Silicon macOS. Source build explicitly targets macOS 14; actual installation/play on another Mac or older macOS remains unverified. |
| Minecraft edition | Java. Bedrock is unsupported. |
| Direct gameplay | Scoped disposable Paper Java 1.21.4 fixtures and natural-world experiments. |
| Newer Java route | 26.2 uses the pinned ViaProxy helper and Minecraft Launcher's arm64 Java runtime. Account linking, joining, reconnecting and a starter house have live evidence. New mechanics remain unverified. |
| Other versions/mods | Client transport detection is broader than gameplay acceptance. Modpacks and every advertised version are not supported by evidence. |
| Models | Codex/ChatGPT and Claude Code subscription profiles; explicit API/local profiles are available through Models. Model availability depends on your account. Local-model training remains paused. |
| Independent installation | A clean tracked-file export can be built and tested locally. A different tester's machine and real sign-in/gameplay remain separate acceptance gates. |
| Distribution | Source build and internal portable packaging. Developer ID signing/notarization and a published downloadable release are not established. |

## Team regrouping

Simple complete requests such as `come to us` and `regroup with the team` use the configured owner as team leader and bypass planning-model calls. The agent refreshes the observed leader position between bounded travel legs, checks destination height, and verifies current proximity. A blocked route may receive one checked canopy-descent or pit-climb recovery before retrying. Unknown player location and blocked terrain are reported separately; the player list alone cannot locate unseen people. Compound jobs retain ordinary goal planning.

The regroup source passes 598 regressions. The updated local app passes signature and relocated empty-profile startup checks and rejoined the active world with state preserved. A live moving rendezvous completed within 2.9 blocks of the leader at full health, with an arrived receipt. A hostile interruption triggered retreat followed by automatic continuation. The leader also moved toward the bot, so this establishes that rendezvous case rather than the full original route or unrestricted navigation. The trial used a fresh regroup request after an earlier enclosure protection failure; recovery from that earlier failure was not autonomous. Continuous following and locating unloaded teammates remain separate capabilities.

## Durable goal milestones

Compound goal briefs can now include a validated dependency graph tied to every original completion check. The controller persists stage evidence, transitions and blockers; rechecks inventory, tool condition and other live requirements before work; and replans at stage boundaries. Resume keeps the original goal and reopens unmet requirements. Earlier saved goals retain their existing checks and use a single compatibility stage. Ordinary planning and the optional Jev selector receive the same active milestone. Original completion verification, safety interruptions, Stop and finite budgets remain authoritative.

The source passes 592 regressions, including a simulated food/tools/shelter mission, restart continuation without repeated feeding, resource regression, invalid graphs and cancellation. This is controller coverage; natural-world completion of the compound mission and Ender Dragon autonomy remain unverified. Intermediate material acquisition still uses existing bounded skills. The milestone graph does not add Nether, stronghold or dragon-combat capabilities.

## What the teammate can do

Saved goals, bounded navigation, gathering, recursive crafting, selected construction, base storage and limited prospecting share an executor with receipts and cancellation. Limited melee self-defense covers individually identified zombies, husks and spiders under equipment/health/spacing checks. It is not general PvP or hostile-world combat. See [autonomy](../harness/autonomy.md), [construction](../harness/construction.md), [prospecting](../harness/prospecting.md) and [combat](../harness/combat.md).

Regression passes prove the tested local cases. Supplied-material fixtures, natural-world completion and installed-app acceptance are different evidence stages. Continuous hostile survival, uninterrupted fresh-world diamond acquisition, broad terrain coverage and independent second-Mac use remain open. Retained task experience is saved evidence and retrieval, not model-weight training.

## Bounded progression checks

The local source trial runner is `harness/test/live-progress.py`. It requires an already connected, alive bot and an explicitly authorized disposable world. It submits one request, records samples and current inventory, and stops on death, disconnect, two minutes without new resources or distinct completed work, or a twenty-minute deadline. Every exit cancels the request and disconnects the service; it does not respawn or retry. Waiting safely for daylight can hit the progress limit and is recorded separately from death. A pass requires retained food, two different tools, and an inspected lit shelter, rather than a planner completion claim.

Use `--minutes`, `--stall-seconds`, `--interval`, and `--output` to set a trial's bounds and receipt directory. Run `python3 harness/test/test_live_progress.py` to check the stop and scoring behavior. Natural-world trials and supplied-material combat or navigation fixtures are separate evidence.

Jev currently judges threat interruption and fight/evade/shelter responses; the selected subscription model still plans general tasks. `MC_THREAT_JUDGE=control` enables those decisions above the harness safety floors, `0` disables Jev, and the default with a key records shadow judgements. Live state exposes the actual mode. A successful connection or fast judgement does not establish better survival or progression.

## Optional skill selection

Source launches can opt into `MC_SKILL_CONTROL=jev`: the general planner offers independent next actions and Jev chooses one for the existing executor. The default remains ordered general planning. Offline fixtures cover cancellation, connection changes, stale observations, fallback attribution, persisted budgets and original-goal verification. A ten-minute live trial completed three selected travel actions and interrupted one harvest, with no selection fallbacks or sampled health loss. Hunger rose from 6 to 9 after two berries of unverified acquisition provenance were eaten; the recovery goal remained incomplete. Each selected proposal had only one option, so no Jev advantage or general natural-world improvement is established. See [skill selection pilot](SKILL-CONTROL.md) for scope, limits and comparison requirements.

## Recovery evidence and experimental planning

Threat judgment and normal planning now share the objective, observed hostile head equipment, and recent recovery outcomes. Unknown observations remain explicit. The bounded journal is scoped to the current world, connection and request.

The existing controller remains the default. `MC_RECOVERY_MODE=adaptive` enables a bounded planner-directed recovery pilot; `MC_THREAT_CONTEXT=legacy` retains the old context for comparisons. Live trials showed improved armed progression from richer Jev context, while the unarmed trials failed and planner-led recovery remains unproven. An early adaptive candidate died; the corrected candidate's armed successes used fallback control. No broad survival claim or installed-app acceptance follows. See [recovery architecture and evaluation](ADAPTIVE-RECOVERY.md).

## Partial work and terrain navigation

Safety interruptions preserve observed progress from the active work task as interrupted feedback, without marking it complete. The planner can use spent search legs and other partial work when deciding what to try next. Completed empty searches can inform a different task, but robust interrupted-search accounting still needs end-to-end acceptance.

Staged travel follows terrain elevation at intermediate waypoints and verifies final three-dimensional arrival. The final stage uses the destination elevation from its first approach; a regression reproduces the former descent onto a lower route beneath the intended landing. A disposable physical hill fixture passed three stages with full health; natural mountainous travel remains separate acceptance. The current source passes 536 regressions. Live food gathering and the latest compact lit camp attempt remain incomplete, with quarry access and hostile recovery limiting progress. These source repairs do not establish installed-app acceptance or broad autonomous survival.

General planning can select the existing checked canopy-descent and pit-climb actions using local footing evidence, and receives their execution receipts. An actual planner trial descended ten blocks and retained four logs at full health; collection was stopped by the observer at the inventory target. The initial trial exposed an intent validator rejection and is retained as a failure. This controlled fixture does not establish hostile natural-world progression.

General planning can also select exact locally observed standable travel destinations. Destinations are checked for known floor, headroom, hazards and distance before execution. Separate actual-planner disposable pit and waypoint trials retained four logs at full health after a six-block climb and a thirteen-block travel receipt respectively. These supplied-tool, non-hostile trials do not establish general survival. Brief clear readings during shelter departure checks now preserve elapsed daytime patience; night still resets it.

Failed safety retries preserve eligible interrupted-request identity while rejecting cancelled, reviewed or unrelated requests. Shelter restoration waits for client chunks before checking the floor, preventing unknown startup terrain from triggering another excavation. A live reconnect preserved depth, health, inventory and enclosure protection. These changes do not remove retry budgets or override Stop. Protected planning avoids repeated calls for unchanged departure feasibility, health, hunger and inventory, retaining its original time and call budgets. Natural-world testing completed a checked waypoint move and eight-log gather after daylight recovery at retained health, then crafted doors and planks. Food and completed camp remain unverified.

## Food recovery and threat observations

Critical hunger with carried food can now be handled by verified eating on clear daylight ground. The controller requires adequate health, grounded dry footing and no nearby hostile, watches throughout consumption, and falls back to shelter when conditions change. The original request can continue under its existing finite continuation cap. Food-triggered shelter recovery also retains continuation eligibility after clearance. Uncertain consumption remains a review blocker across recovery tasks.

Berry harvesting persists its current source and distinguishes approach, pending activation, confirmed crop change and confirmed pickup. Interruption feedback preserves these stages, prior harvest receipts, rejected sources and carried berries. Inventory gained during approach is not relabeled as a verified harvest. These repairs pass 583 regressions. A continuing-world trial recorded successful berry harvest and consumption, reaching hunger 20 and health 20 with four berries retained. The original saved goal was then verified during a freshly inspected shelter watch and persisted before disconnect. Source restarts and the initial failed attempts are retained; this is scoped natural-world progress, not a reliability rate or a model comparison. The clear-ground feeding branch has regression coverage but was not exercised by this trial.

Automatic continuation retains failed attempts as current evidence. An explicit manual Resume retains the existing one-retry semantics. Both ordinary and protected planning receive the same bounded loaded berry scan used by harvesting, distinguishing ripe, unripe, absent and unknown observations. The executor rechecks ripeness after approach. General feeding goals can use live hunger and health thresholds without requiring a particular food species.

Rich Jev context includes each observed hostile's vertical offset and a loaded-terrain sightline marked clear, blocked or unknown. An obstruction is geometry evidence, not proof that a mob cannot reach or attack the agent. Existing hostile classification, distance checks and emergency safety floors remain in place. Regression coverage verifies that a blocked nearby creeper still triggers the existing hard floor.

Earlier natural 26.2 trials retained tools, doors, planks and four crafted torches but repeatedly failed to find food. The later scoped food recovery above passed its original hunger and health checks. The compact camp remains unfinished, and improved Jev behavior has not been established.

## Minecraft release upgrades

A single compatibility manifest controls bridge selection and integrity. The [upgrade workflow](COMPATIBILITY.md) stages official releases, verifies translation paths for new and retained versions, and preserves rollback artifacts. Protocol 777 / Minecraft 26.3 remains blocked until a candidate passes; no 26.3 gameplay acceptance is claimed.

## Maintainer records

Detailed plans, dated acceptance reports, raw receipts and past failures live in the owner's separate `workstreams/minecraft/` archive and ignored local result directories. References to historical receipt paths in technical notes identify that evidence; those private files are intentionally not required by this clone. The repo's guides describe the installation contract and capability limits needed by other users.


## Onboarding verification, 11 September 2026

A fresh export containing only the staged source files installed its 94 locked npm packages and built both development and portable apps on the maintainer's Apple Silicon Mac. No `.env`, `node_modules`, generated bridge, saved profile or owner archive was supplied to that export. Both native binaries report macOS 14.0 as their minimum target and pass signature verification. The portable runtime passes its empty-profile startup/authentication checks without gameplay or inference.

The native development app was opened under a separate app identifier with an empty profile. It showed World connections, blank account/world fields and no private-lab shortcut. Existing subscription model metadata was discoverable; no account was linked and no game task or model response was requested. All 319 regression tests pass, including standard/custom provider CLI path discovery. A different tester's machine, provider sign-in and actual gameplay remain unverified.

## Emergency shelter verification

Emergency burrows seal once three cells give headroom, then deepen beneath the cap. Burrow and hut success requires an observed closed cavity without liquid or hostile occupants. The waiting loop rechecks enclosure integrity and health; failures reach recovery history. Escape destinations and sustained clearance are separate checks, and renewed danger ends the open-ground watch immediately. Confrontation exits reuse the combat executor's current readiness checks.

A supplied unarmed Java 1.21.4 fixture maintained full health for 30 seconds after sheltering and rejected an injected intruder. A bounded Jev-controlled trial subsequently remained at full health for three minutes, retaining its food, but gathered no requested logs. An earlier candidate died during an unsafe open-ground wait and its failure was retained. Sustained protection is scoped evidence; the later protected-planning pilot below adds one successful departure and useful continuation. Natural-world survival and installed-app acceptance remain unproven. The final confrontation-exit guard has regression coverage, not a separate live trial.

## Protected planning pilot, 18 September 2026

`MC_SHELTER_PLANNING=1` lets the selected general planner reason during verified shelter, choose a checked departure, and prepare the first work plan before exposure. It remains off by default. Jev continues to handle threat judgments. See [sheltered planning](SHELTERED-PLANNING.md) for cancellation, protection, freshness and budget limits.

Four five-minute disposable Java 1.21.4 trials compared the current controller with protected planning under pursuit and a blocked-route variation. Protected planning met the eight-log inventory target in one of two trials; control met it in neither. The successful trial retained eight logs and four bread in 284.2 seconds at full health throughout. After a failed departure, its next decisions explicitly waited for more separation before trying again. Logs came from naturally generated trees outside the supplied arena; the fixture's requested tree provenance was not satisfied.

The blocked-route planned trial survived at full health but collected no logs. It resumed gathering once, then renewed pursuit exhausted the existing idle safety-continuation limit and left the request interrupted. Control died in the pursuit trial and stayed protected without resources in the blocked-route trial. Independent saved-player inventory checks verified all four outcomes. These single trials establish partial progress, not reliable generalization, a Jev-wide reasoning improvement, natural-world acceptance or installed-app acceptance.

## Family desktop preview

`desktop/` contains a separate Electron companion with Play, Talk, Stop, a parent setup screen, bounded LAN discovery, native Windows and Mac speech helpers, and platform-specific runtime/process handling. The existing native Mac application is unchanged. The parent selects the world/account/model once; LAN discovery can refresh the saved world port only when exactly one matching advertisement is found. Different or ambiguous worlds require parent intervention.

The clean desktop resource build and packaged first-run UI were checked on Apple Silicon macOS. Fixture regressions cover Windows paths and process-tree cancellation, IPC limits, late speech cancellation, Stop ordering and LAN matching. A real harness integration test checks isolated startup, token/origin enforcement and clean shutdown without gameplay or inference. The Windows x64 voice helper and per-user NSIS installer have been cross-built on macOS. Installation, speech-helper startup and clean shutdown passed in a Windows 11 ARM VM, alongside 18 desktop/platform checks and actual owned-process tree termination. Short English button phrases now supplement dictation. A two-voice synthetic fixture improved from 8/18 to 13/18 checks, with five phrase failures remaining for the second voice. Actual speech accuracy, account linking in this new shell and the full spoken gameplay loop remain unverified. The installer is an unsigned internal test build, not a supported release. See [desktop setup and acceptance](../desktop/README.md).

Goal verification can finish an interrupted request during recovery only after fresh enclosure inspection and all original criteria passing. Harmless inspection can refresh observations during healing; effectful choices retain freshness checks. Already-collected berries need no extra pickup route. Blocked request status is saved before reflection so shutdown cannot leave stale running state.
