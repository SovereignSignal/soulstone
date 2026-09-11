# Named construction projects

`construct` accepts a declarative blueprint and a project name. The same interface is available to every planner provider. It is separate from the small `build` shelter action and from the saved `projects.base` resupply stations.

A region has inclusive integer corners `{x,y,z,x2,y2,z2,block}`. Later regions override earlier regions. `air` carves the proposed blueprint only. It does not authorize world excavation. A `checkpoint` region has identical corners and specifies a feet position the bot must physically reach after placement.

Limits: 128 regions, 16,000 expanded region cells, 2,048 placed items (door upper halves add occupied cells), relative x/z −16..16 and y 0..16, 2–32 checkpoints. This version accepts full solid blocks, straight bottom-half stairs, hand-operated doors and fence gates. Slabs, stair corners/top halves, controlled hinges, terrain grading and temporary scaffolding remain future work. The existing shelter path retains its verified door and workstations.

Each invocation places up to 64 blocks, re-observing matching blocks before consuming inventory. Progress and the origin persist with the named project. Supply gaps return the unplaced material totals. The model can acquire bounded batches, then continue the same project. `construct` with the existing project name and `design: []` loads its saved blueprint. A normal construct call keeps its saved blueprint. Explicit modify goals can use revise for bounded patches at the same origin, as described below.

Construction preflights obstructions, reviews checkpoint connectivity under the level-pad assumption, and uses normal no-dig navigation and server-confirmed Mineflayer placement. Construction walking permits descents of at most three feet-position blocks onto full solid, non-hazardous landings with clear headroom so a finished roof does not trap the builder. It rejects liquid, partial-block and unknown landings. Ordinary travel and excavation retain their one-block descent limit. It never uses server fill commands. After the final block it walks all checkpoints in order, waits for ground contact on each expected floor, checks support and headroom, and rechecks the structure. Material validation uses actual collision shapes because the registry labels stairs and doors as block bounding boxes. A partial batch cannot establish completion. Stop and explicit Resume use the existing durable request mechanism.

## Natural site and material planning

A new unreserved `construct` surveys loaded natural terrain within 24 horizontal blocks of the owner, from three blocks above to sixteen below their elevation. Recorded project footprints and stations have an exclusion margin; occupied footprints, water, steep terrain and obstructed building volumes are rejected. Candidate edges must offer a step onto the planned floor. These are bounded local observations, not a global terrain planner; unrecorded player-placed natural blocks cannot always be distinguished from generated terrain.

With a complete solid floor at relative y=0, a footprint up to 81 cells may adapt to at most three blocks of ground variation and at most 128 foundation blocks. It places support columns into observed air above existing natural ground. It does not cut terrain. The executor prefixes foundation regions and shifts the model's design/checkpoints upward, preserving relative geometry. Cobblestone is preferred; an explicit material palette constrains foundations too. The complete fitted design must still satisfy region, volume, height, item and explicit block-budget limits. Larger footprints require level ground.

The first invocation reserves the fitted design/origin and returns the full unplaced material totals with `partial=true` and `placed=0`, before world placement. Subsequent acquisition uses existing crafting/gathering/mining actions. Continue with the saved project name and empty design. The reserved blueprint includes foundation coordinates, so later revision patches use that saved frame. Construction rechecks obstructions before each batch; site reservations are local project state, not server-enforced land claims.

## Stateful building blocks

Use the existing region `block` string to specify states:

```json
{"x":2,"y":0,"z":2,"x2":2,"y2":0,"z2":2,"block":"oak_door[facing=north]"}
```

Doors, gates and stairs require `facing=north|south|east|west`. Stair facing is uphill; `half=bottom` is optional and the only supported half. Examples are `spruce_fence_gate[facing=east]` and `stone_brick_stairs[facing=south,half=bottom]`. Ordinary full-block designs retain their existing format. State support is checked against the connected version's registry before placement; only Java 1.21.4 has live acceptance so far.

A door region describes lower cells only. Each consumes one item and reserves a second cell automatically. Upper-cell overlap is rejected. Doors and gates finish closed and unpowered. Door/stair facing must match exactly. Minecraft can reverse a gate facing when opened from the opposite side; gate verification preserves its passage axis and rejects perpendicular rotation. Door hinge is chosen by Minecraft; stair corners and waterlogged stairs are rejected. Iron doors require a future redstone capability. All these placements require full-block support below. The two approach cells along a passage's facing axis need level support and two clear headroom cells. Put architecture checkpoints on full-block landings, outside the barrier/stair cells.

The executor observes exact states, waits for rotation before placement, and never silently treats a wrong orientation as success or a material shortage. During unfinished construction it opens matching installed project doors/gates, including after reload, and opens each newly placed passage immediately. This preserves access to outside placement positions while walls and roofs go up. Final verification still closes passages; a paused or partial build can leave them open. Placement approaches also check the actual eye ray and player body clearance. A fractional-height bed can invalidate the pathfinder's ideal voxel arrival without invalidating a real placement viewpoint. Unusable viewpoints exclude that standing column before a bounded retry; cancellation and other navigation failures still stop. It can resume a correctly oriented passage left open by an interrupted check. An unexpected block or wrong orientation pauses for inspection; destructive repair is not implemented.

Each passage must confirm closed/open state, physically visit its centre while crossing both ways, and confirm closing. The executor opens passages for the ordered building walkthrough, then closes them and rechecks all planned cells, including door upper halves. Open gates need a distance-based interaction approach because their collision shape is empty. Open doors/gates use collision-aware movement; closed barriers remain blocked. Complex interdependent barrier layouts can still fail navigation, and interruption can leave a passage open until resumed. Neither receives a completion receipt.

The blueprint reachability review is only an approximate level-pad check. Actual stair ascent/descent and passage crossing establish access for a completed run. Supplies and site preparation in the architecture fixtures are administrative; the executor performs survival placement and walking.

Tests: `test/building-blocks.test.js`, `test/goal-contract.test.js`, `test/building-blocks-lab.js`. `test/design-functional-build.js` asks the selected Astra subscription for fresh geometry rather than supplying a predefined gatehouse. Runtime tools and blueprint validation are provider-independent.

## Furnishings and revisions

Named projects support crafting tables, furnaces and barrels, plus colored beds such as `red_bed[facing=south]`. One bed item reserves both foot and head cells; facing points toward the head. Both halves require support and clear headroom. Completed construction opens each workstation or storage window and physically checks bed access. Contents are observed without transfers. Beds are Overworld-only here; the receipt explicitly says sleeping was not tested. This does not set a spawn point or implement a sleep command. Base storage/smelting actions still target the separate starter base.

The goal brief uses `projectMode: modify` for an explicit change to an existing named project. `revise` takes its project name and a patch of 1–32 cuboids covering at most 64 cells. It appends those regions to the saved blueprint, retaining the original coordinates and existing walk checkpoints. An explicit air patch can remove a recorded structural cube. The previous design is saved alongside the new design for recovery. A pending revision continues through `construct` with the same name and empty design; repeating the patch is not a continuation.

Before demolition, the executor validates geometry, observes the full planned footprint, checks the version's block states, and requires the changed placements' materials. It only dismantles matching recorded structural full cubes from the supported masonry/wood/glass/wool/concrete families. Containers, furnishings, doors, gates and stairs are protected. Unexpected contents, changed targets, occupied support and falling-block support stop the operation. Removal is server-confirmed, then ordinary placement and full furnishing/access checks complete the revision. This is resumable bounded work, not an atomic transaction or arbitrary demolition tool; partially removed masonry can remain after interruption. Plain construction can restore missing blocks without a blueprint edit.

Completion criteria now include requested furniture counts and fresh interaction receipts. Construction checks re-observe explicit air cells as well as solid cells. A completed empty-plan response cannot omit requested furnishings. Revision deduplication preserves region extents and override order. The general goal prompt was also corrected to advertise the actual door/stair/furnishing capabilities.

Acceptance evidence is in [results summary: scope and evidence limits](../docs/STATUS.md). Fixtures include an unexpected filled chest in a proposed edit cell, a seeded filled barrel, a preserved external chest, a masonry replacement, missing-roof repair, and a model-planned second furnishing pass through the normal companion loop. These are supplied-material, prepared-room Java 1.21.4 tests. Bed assembly/access is covered; sleep, wool sourcing, arbitrary project demolition and terrain grading are not.

## Castle development case

The example [castle blueprint](blueprints/castle.json) was generated by the selected `gpt-6-astra` Codex subscription. It contains 516 blocks across 73 compact regions: 253 stone bricks, 183 cobblestone, 72 spruce planks and 8 glowstone. It provides a lit hall, wide open gateway, permanent full-block staircase, roof terrace and four accessible battlemented turrets. Eighteen ordered walkthrough checkpoints cover the route out and back.

The architecture experiment supplies materials and a flat pad administratively in the explicitly disposable lab. The executor places the actual castle in survival mode. This tests construction and access, not autonomous quarrying, stone-brick smelting, site preparation, mob protection or a furnished residence. The open gateway has no closing gate yet.

`test/design-castle.js` records model input/output. The first design was valid but the existing intent guard lacked the new action; that guard was corrected and the recorded model blueprint was recovered without changing its geometry. Local regressions cover that dispatch path.

`test/construction-lab.js` executes the design with HarnessTest on the isolated elevated fixture, then compares all placed blocks through independent server commands. `test/prepare-live-castle.js` records the one-time supplied kit and shoreline pad. `test/live-castle.py` submits the request through the companion and records its state. Never rerun the setup script against a completed castle: it supplies another kit.

Live castle origin: −582,65,−315. Entrance checkpoint: −577,66,−315. Original spruce base and stations retain their saved project and contents.

Results are recorded in [results summary: scope and evidence limits](../docs/STATUS.md). A started or partial run is not a pass.

Historical castle acceptance: the live castle completed in 761.23 seconds with no failed actions. All 516 blocks passed independent server checks; all 18 grounded checkpoints passed on the final source. 126 local regression tests pass. The companion was idle at the entrance after that acceptance; current position is read from the live app.


Natural-site acceptance: the live `compact_storehouse` request chose a 5x5 footprint at `(-590,64,-316)`, added 22 foundation blocks, acquired/crafted its shortages, and built 97 items with two barrels, a crafting table, a wooden door and six walk checkpoints. A planned companion restart at 47 verified blocks preserved the same request, design, origin and inventory. One mining approach failed and the model recovered through the saved base; no code changed during the run. Independent audit and current limitations are recorded in the results summary.

### Survival lighting

Named construction and revision now accept floor-supported `torch` cells. Support must be a full block, including barrels and crafting tables; unsupported torches and checkpoint overlap are rejected. Torches do not count as structural support in the geometry review. Placement sneaks when clicking furniture and verifies the resulting server block. The pinned Mineflayer version needs a narrow sneak-state supplement on Java 1.21.3–1.21.5; newer and older protocol paths retain their native handling. Placement counts now describe confirmed prior blocks, rather than counting the attempted cell early.
