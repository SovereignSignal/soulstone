# Recovery decisions and evidence

The existing safety controller remains the default. The selected general planner still owns the work objective. Jev can judge immediate threat responses when explicitly launched in control mode.

## Shared observations

Threat judgments and normal planning receive the current objective, observed hostile identities and head equipment, and recent recovery actions with before/after states. An unknown equipment slot stays unknown. An entity disappearing from the loaded observation radius does not establish death or ended pursuit.

The bounded recovery journal persists with the world profile. Retrieval requires the current connection and request identity, so old-world or pre-reconnect encounters cannot silently become current facts. It records failed and cancelled actions as well as successful execution. Execution success alone does not establish tactical success.

`MC_THREAT_CONTEXT=legacy` is a comparison switch that withholds this extra context and restores the earlier generic threat-mechanics wording. Default context is `rich`.

## Experimental planner-directed recovery

`MC_RECOVERY_MODE=adaptive` enables an opt-in pilot for hostile interruptions of active work. It uses the existing planner provider and executor, with five choices: inspect, defend, flee, shelter, or resume. Each choice includes a short expected observable result. There is no generated-code execution or model-weight training.

Inspection returns nearby resource positions, loaded threats and candidate ground to the next decision, together with an explicit statement that routes remain unverified. Defense rechecks its existing equipment, target and health requirements. Resumption requires fresh clearance; a model saying the area is safe is insufficient. Shelter delegates to the existing verified-shelter capability.

The loop allows four decisions, 25 seconds per decision and 90 seconds overall. It cancels on Stop, death or connection change. If danger becomes imminent while the planner is pending, it cancels deliberation and returns to the established fast safety controller. It does not repeatedly move the bot simply to prolong model thinking time. Invalid or over-budget responses also produce a labelled fallback.

The first live candidate demonstrated why this boundary matters: repeated inspection plus protective movement failed. Planner-led recovery remains experimental and is disabled by default. A successful fallback does not establish success of the adaptive planner.

The source service's state endpoint exposes the actual recovery and context modes. Native app environment forwarding is unchanged; setting a shell variable does not establish the mode of an independently app-launched service. Verify live state when running a comparison.

## Evaluation

Use disposable worlds and identical objectives, equipment, game settings, models and action implementations. Keep unchanged control, richer evidence and changed decision authority separate. Freeze code and prompts within a comparison cohort, retain failed trials, and classify model decisions, verified outcomes and fallback actions separately.

Record resources retained, sampled health, deaths, repeated ineffective choices, model latency/cost, interventions, time waiting and time without progress. A supplied encounter does not establish natural-world survival, fresh-world progression or installed-app acceptance. Multiple independent seeds are required before generalising from exploratory fixtures.

Run the full harness regression suite for changes. The focused `test/adaptive-recovery.test.js` covers evidence propagation, failed-action feedback, inspection results, fresh feasibility checks, cancellation, budgets and imminent-danger handoff.
