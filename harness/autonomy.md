# Goal planning and reusable experience

A model-planned task starts with a short public brief: intended outcome, constraints, milestones and observable completion criteria. Every configured reasoning provider uses the same brief, observations and executor. The model then chooses bounded actions, receives results and revises the next steps. This adds no model weights or local-model training. Existing deterministic wood commands retain their fast path and executor receipts; they do not call the model for a brief or reflection.

## Completion

The controller checks current inventory, usable tools, current-request delivery/storage receipts, construction cells, furnishing interaction receipts and physical walkthroughs, height/material/budget constraints, saved destinations and starter-base checks. A model's empty action list cannot finish a task with unmet measurable criteria. Two unchanged premature completion claims block the request with the missing requirements. Unsupported or subjective requirements stay marked for review.

The model interprets the user request. That interpretation can still miss a requirement. A passing checklist establishes the encoded conditions, not universal success for every natural-language request. Live acceptance tests therefore also check the original request directly against server state.

The saved brief survives Resume and cannot be changed by later planning rounds. Stop invalidates both pending planning and pending reflection. Simple status questions report progress without cancelling the active goal. General conversation during work still needs broader routing.

Intermediate supplies, a changed mining frontier and newly rejected excavation routes count toward recovery progress. A request can continue while it eliminates different routes; unchanged repeated failures and the 24-round/45-minute budget remain bounded. Premature completion is checked against both the missing goal conditions and current progress, so real prerequisite work resets an earlier rejection. When no supported recovery remains, the blocked message retains the model's specific explanation and request for help.

## Construction and transfer

A new build receives a fresh project name. It cannot fulfill the request by replaying an older project's completion. The planner receives a coarse survey of nearby clear level sites, current materials, version facts, previous outcomes and relevant experience. The executor rechecks the actual chosen site, block geometry, headroom and access before acting.

An unstarted project without a reserved origin can revise its design after a geometry or site rejection. Once the executor reserves an origin, ordinary construct calls keep the blueprint fixed for consistent resumption. An explicit modify goal can use a bounded revise patch, preserving the previous design, origin and walk checkpoints. Only matching recorded structural cubes can be removed; furnishings and containers stay protected. This does not authorize arbitrary demolition.

Saved project blueprints exist for resumption and inspection. The separate experience store records compact outcome facts and conditional strategies, without saving a blueprint or coordinate route as a reusable lesson. Variation should follow different needs and conditions; random novelty is not an acceptance criterion.

## Experience

`state/experience.json` is private, profile-scoped and version-filtered. It retains at most 80 task experiences and retrieves up to four relevant entries by overlapping capabilities and text. This is deliberately simple retrieval; it is not a semantic search service.

After an attempted task, the selected model may suggest up to three lessons citing execution evidence. References must exist; partial execution cannot support a completed result. Partial returns retain actual excavation counts, supply needs and return status, and can support conditional lessons about prerequisites. All causal strategies remain labelled `conditional_hypothesis`. Facts and hypotheses stay separate. Reflection failure does not invent a lesson. No model/provider switch is required to use this memory.

Resume updates the existing request's experience instead of permanently retaining its first failed verdict. The same experience ID survives, with up to eight compact outcome revisions retaining earlier blockers. Current evidence, verdict and lessons are re-recorded after the resumed attempt. Restart tests verify the updated record is retrieved for the same profile; another world's profile is rejected. Raw request feedback and episodes remain the detailed trace. This is local persistent retrieval, not model-weight training.

For developer-session continuity, the maintainer's private working-state note links the current objective, incident diagnosis, evidence and remaining acceptance work. Established general improvements persist in source, capability instructions and regression tests; world coordinates and account state remain private to their world.

A stored lesson being retrieved does not prove it improves performance. Measuring that requires paired held-out trials with and without experience, across more tasks and conditions. Weight training remains paused.

## Tests

```sh
npm test
MC_LAB_EXPERIMENT=yes node --env-file=.env test/autonomy-lab.js
```

The live fixture resets only HarnessTest and isolated elevated pads. It uses the selected Astra subscription profile, raw logs for an oak platform, a narrow site and cobblestone for a new higher lookout, a controller reload and bot reconnect between tasks, and a separate compound equipment request. There are no supplied blueprints or operator interventions during requests. Independent assertions cover blocks, access, deck space, material/budget limits, fresh geometry, prior-build preservation, experience retrieval and carried supplies.

These are bounded peaceful Java 1.21.4 cases with supplied resources and prepared sites. They do not establish general survival, quarrying/site preparation, farming, combat, all-version support or 2b2t readiness. Actual outcomes, timings and failures are kept in the maintainer's private results record.


The first [paired experience pilot: scope and evidence limits](../docs/STATUS.md) found no reliable benefit. Construction succeeded in both arms; an equipment failure exposed an inventory-crafting synchronization gap. After repair, both equipment arms passed. Keep lessons provisional and separate executor reliability from reasoning comparisons.

## Durable milestone scheduling

New task briefs include `milestonePlan`: a bounded, acyclic graph whose nodes reference zero-based indices in the immutable `criteria` array. Every criterion is covered exactly once, including review-only requirements. Existing prose `milestones` remain readable, and older stored contracts without a graph use one stage without rewriting the original goal. The graph groups final outcome checks; bounded acquisition/build skills and action planning continue to resolve intermediate supplies.

`requestProgress.mission` records the active stage, dependencies, current check evidence, last passing observation, bounded transition history and last blocker. The shared observation loop reevaluates the original checks. Inventory, health, hunger and tool condition can reopen a stage; receipt-based checks retain their existing request-scoped semantics. A passed stage is not a permanent guarantee that the world will stay unchanged. Pause and disconnect require a new observation before selecting work.

Both ordinary planning and Jev selection receive `activeMilestone`. Execution drops the remainder of a batch when fresh checks change that focus, so later stages are replanned against current observations. This schedules the planner focus; it does not prove that an arbitrary proposed action advances it. Existing action validation and full-goal verification remain the effect and completion boundaries. Safety can interrupt any stage, and budgets are not reset by milestone transitions.
