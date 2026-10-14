#!/bin/bash
# Test world only: put the bot beside the Nether portal at the fortress with a bow kit, then start a watched run.
# stage-fortress.sh <run-name> [minutes]
set -euo pipefail
NAME=$1 MIN=${2:-40} ARROWS=${ARROWS:-64}  # ARROWS=128 from run 116: about 3.5 arrows a kill and a rod half the time
# REQUEST added 13 Oct for step 4 (the natural fortress); the default is the blaze-range request.
REQUEST=${REQUEST:-"Kill blazes here with your bow and collect 3 blaze rods, then come home through the portal."}
# Settings, from the environment (defaults are the lab's):
#   MC_CONTAINER  the test world's Docker container (rcon-cli runs inside it)
#   MC_BOT        the bot's player name
MC_CONTAINER=${MC_CONTAINER:-mc-sandbox} MC_BOT=${MC_BOT:-SoulStone303}
r(){ docker exec "$MC_CONTAINER" rcon-cli "$1"; }
r "clear $MC_BOT" >/dev/null
r "execute in minecraft:the_nether run tp $MC_BOT -68.5 61 -41.5"
for c in "bow" "arrow $ARROWS" "cooked_beef 16" "cobblestone 64" "iron_sword" "iron_pickaxe" "torch 16"; do r "give $MC_BOT minecraft:$c" >/dev/null; done
for s in "head iron_helmet" "chest iron_chestplate" "legs iron_leggings" "feet golden_boots"; do set -- $s; r "item replace entity $MC_BOT armor.$1 with minecraft:$2" >/dev/null; done
r "effect give $MC_BOT minecraft:instant_health 1 5" >/dev/null; r "effect give $MC_BOT minecraft:saturation 1 5" >/dev/null
echo "blazes within 40: $(r "execute in minecraft:the_nether positioned -60 61 -39 if entity @e[type=blaze,distance=..40]")"
sleep 3
# Runs land in LAB_OUT; the watcher and the bot's state come from SOULSTONE_RUN.
SOULSTONE_ROOT=${SOULSTONE_ROOT:-$HOME/soulstone} SOULSTONE_RUN=${SOULSTONE_RUN:-$HOME/soulstone/run}
LAB_OUT=${LAB_OUT:-$SOULSTONE_ROOT/harness/results/lab-runs} HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$LAB_OUT" && cd "$LAB_OUT"
# A blaze fight on arrival is the bot doing its job; post once it is idle again.
for try in $(seq 1 20); do
 rm -rf "$NAME" "$NAME.out"
 SOULSTONE_ROOT="$SOULSTONE_ROOT" SOULSTONE_RUN="$SOULSTONE_RUN" MC_CONTAINER="$MC_CONTAINER" MC_BOT="$MC_BOT" setsid nohup python3 "$HERE/watch.py" "$NAME" "$MIN" "$REQUEST" --allow-nether > "$NAME.out" 2>&1 < /dev/null &
 # Wait for the watcher to say how the post went (its API calls take up to 15 s on a Pi);
 # a fixed 5 s read an empty file as success on 13 October and the retries stopped.
 for i in $(seq 1 40); do [ -s "$NAME.out" ] && break; sleep 1; done
 grep -q "agent is not idle" "$NAME.out" || break
 sleep 4
done
cat "$NAME.out"
