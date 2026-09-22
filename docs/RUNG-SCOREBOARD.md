# Rung scoreboard

The scoreboard measures **natural progression**: per run, time to each tech-tree rung, deaths, and planner rounds. A week of development is judged by whether the rung line moved — not by regression-test count.

## Ladder

Ordered rungs (client-side evidence from companion `GET /state` only):

`wood_tools` → `stone_tools` → `shelter` → `iron` → `iron_pickaxe` → `diamond` → `obsidian` → `portal_lit` → `nether` → `blaze_rods` → `ender_pearls` → `eyes` → `end` → `dragon`

Predicates use inventory counts, `litShelterVerified` / verification checks, and `survival.dimension`. Worn armour is not in `inventory` and never counts. A rung stays reached once true; `lost_at` records a later false reading.

The scorer **never** talks to the Minecraft server or VM — only the companion API in the agent state dir.

## Run a scored trial

Against a live agent whose state dir holds `companion-api.json`:

```bash
cd harness
python3 test/rung-score.py \
  --state-dir ~/soulstone/run/state \
  --request 'craft a stone pickaxe and a stone axe and eat until hunger is at least 18' \
  --hours 2 \
  --poll 5
```

Writes `results/rung-<timestamp>/report.json` and `report.md`, and appends one line to `results/rung-scoreboard.csv`.

## Read the CSV

`results/rung-scoreboard.csv` columns: start, request, hours, max_rung, times (seconds) for wood through diamond, deaths, rounds, terminal_reason. Empty time cells mean unreached. Plot recent runs:

```bash
python3 test/rung-score-plot.py
```
