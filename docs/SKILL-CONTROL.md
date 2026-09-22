# Experimental skill selection

The default controller executes an ordered plan from the selected general model. A source launch with `MC_SKILL_CONTROL=jev` enables an optional controller for formulated task goals. The general model offers up to eight independent next actions; Jev selects one, and the existing executor runs it. This does not add Minecraft capabilities or train model weights.

The pilot uses the existing TypeSafe credential and model configuration. A missing key blocks the request before goal formulation. `MC_THREAT_JUDGE=0` disables that credential route and therefore cannot be combined with the pilot. Threat handling remains a separate controller, with its existing safety floors. The native app does not expose or forward this experimental flag; building the source does not enable it in an installed app.

## Planning and execution

Every offered action must stand alone with currently observed prerequisites. The ordinary plan schema, intent validation, project constraints, travel checks, uncertainty handling and goal verifier still apply. Transfer, revision and indefinite following actions are excluded from this first pilot. Jev receives the saved goal, current objective, observations, recent results and only the eligible offered choices. Its output cannot supply new arguments or code.

A background planner checks for changed observations every 15 seconds, with one request in flight. It does not repeatedly call on unchanged observations. When an action is needed, an exhausted or stale proposal forces fresh planning. A usable existing proposal can supply the next action while its replacement is pending. Background planning never interrupts a running skill. Skill execution keeps its existing time bounds, which can be as long as ten minutes.

A proposal expires 45 seconds after its observation was captured. Planner requests have a 30-second deadline; Jev selection has a 2.5-second deadline. Providers too slow for those limits will block or fall back, and need separate measured tuning. A Jev failure selects the first still-eligible planner option and logs a fallback. Missing or expired planner evidence blocks. Neither case counts as a Jev success.

Selection rechecks physical observations, request identity, connection identity, cancellation and action eligibility before handing an action to the executor. Failed or partial action results invalidate proposals, including any planner response already in flight. Stop and request replacement invalidate pending work. The existing original-goal verifier remains the completion authority.

## Budgets and evidence

Each saved request has cumulative `skillControl.plannerCalls`, `decisions` and `fallbacks`. At most 24 pilot planner invocations and 96 selection attempts are allowed across its resumes. These are controller invocation limits, not a dollar cap: goal formulation, reflection, protected planning, threat judgment and provider-internal repair have their own existing controls. Existing active-time, stagnation, planning-round and safety-continuation limits also remain.

`GET /state` reports `skillControl.mode` and the saved counters. Episode logs record planner inputs/results, readiness, discarded proposals, selection latency and token metadata when supplied, fallbacks, selected actions and ordinary execution receipts. Records can contain private world observations; keep them outside Git.

Offline coverage includes mocked transport, default-controller compatibility, original-goal verification, delayed providers, Stop, changed connections and health, failed actions, stale proposals and persisted budgets. It establishes controller behavior with fixtures. It does not establish a live TypeSafe response, improved natural survival, Ender Dragon capability or installed-app acceptance.

For a comparison, freeze the source and model configuration, use matched disposable world snapshots, and change only this mode. Retained food, a stone axe and pickaxe, and a physically inspected lit shelter are separate outcomes. Preserve failures, safety interventions and fallback counts. The existing `harness/test/live-progress.py` provides bounded observation and cleanup; read its scoring limits before using it. A continuing personal world is an integration smoke test, not a matched benchmark.

## First live integration result

One ten-minute continuing-world trial exercised five general-planner calls and four live Jev selections (three completed travel actions and an interrupted berry harvest), with no selection fallbacks. Health stayed at 17; hunger rose from 6 to 9 after two berries were verifiably eaten. Their pickup provenance was unverified. The original recovery goal remained incomplete. Safety interrupted work and the deadline disconnected the service with the saved request resumable.

Every selected proposal offered only one option. This verifies the live handoff and scoped persistence, not a Jev advantage or meaningful choice between alternatives. Food-source access, completed acquisition and useful continuation after safety remain unproven. The matched comparison has not run.

A subsequent food-recovery continuation achieved the original hunger and health goal with four berries retained, after repairs to harvesting evidence, pickup handling, inspection during healing, failure persistence and goal verification in shelter. It retained the same goal and spent pilot counters. This still does not establish a Jev advantage; see [food recovery](STATUS.md#food-recovery-and-threat-observations).
