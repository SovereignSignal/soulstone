#!/bin/bash
# Run 127 (13 Oct, lab-1): only blazes above the deck count (y 61 up; the bot stands at y 61 on y 60 bricks).
# A blaze at y 59.0 under the east end filled the old box from y 59, the range never summoned and run 126 gave up with nothing in sight.
# Test world only. A blaze range on the portal bridge (Nether, x -68..-55, y60, z -43..-39).
# While the test bot is on the bridge and no blaze is over the bridge (within 12 of its middle;
# 64 until run 110: fortress blazes behind bricks, out of the bot's sight, suppressed every summon), summons one over the bridge
# so its rods fall on the bricks; at most MAX summons. Since run 114 (12 October) it summons only when no blaze is within 24 of the portal: the fortress's own blazes plus top-ups put five round a sealed portal room and it never cleared. Clears wither skeletons within 40 of
# the portal. Bounded to MINUTES; logs every action with the server reply.
# With a fourth argument "hoglins" it also clears hoglins and magma cubes within 24 of the portal and skeletons within 40 (added 10 October,
# run 103: the crimson-forest pack beside the bridge kept the bot walled in or sent home all run).
# blaze-range.sh <log-file> [minutes] [max-summons] [hoglins]
LOG=$1 MIN=${2:-40} MAX=${3:-10} HOG=${4:-}
# Settings, from the environment (defaults are the lab's):
#   MC_CONTAINER  the test world's Docker container (rcon-cli runs inside it)
#   MC_BOT        the bot's player name
MC_CONTAINER=${MC_CONTAINER:-mc-sandbox} MC_BOT=${MC_BOT:-SoulStone303}
r(){ docker exec "$MC_CONTAINER" rcon-cli "$1"; }
end=$(( $(date +%s) + MIN*60 )); n=0; last=0
# At least GAP seconds between summons (run 116: the 24-block rule alone summoned four in 30 s and took the bot from 20 to 7).
GAP=${GAP:-60}
# Run 118, later: the solid bridge ends at x -55; five kills at x -53 to -49 dropped their rods into the lava sea (y 31).
# Summon at x -62.5 over solid bridge, and count only blazes over it (x -76 to -56).
# Run 118: only blazes in the air over the bridge (y 59 up) count. The 24-block rule counted the fortress's own
# blazes in the corridors below (y 53 to 58, behind bricks), never summoned, and run 117 gave up with nothing in sight.
while [ "$(date +%s)" -lt "$end" ]; do
 if r "execute in minecraft:the_nether if entity @a[name=$MC_BOT,x=-62,y=60,z=-41,distance=..24]" | grep -q passed; then
  k=$(r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=wither_skeleton,distance=..40]")
  case "$k" in *Killed*) echo "$(date -u +%T) $k" >> "$LOG";; esac
  if [ "$HOG" = hoglins ]; then h=$(r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=hoglin,distance=..24]"); case "$h" in *Killed*) echo "$(date -u +%T) hoglins: $h" >> "$LOG";; esac; m=$(r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=magma_cube,distance=..24]"); case "$m" in *Killed*) echo "$(date -u +%T) magma cubes: $m" >> "$LOG";; esac; k=$(r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=skeleton,distance=..40]"); case "$k" in *Killed*) echo "$(date -u +%T) skeletons: $k" >> "$LOG";; esac; fi
  if [ "$n" -lt "$MAX" ] && [ $(( $(date +%s) - last )) -ge "$GAP" ] && r "execute in minecraft:the_nether if entity @e[type=blaze,x=-76,y=61,z=-50,dx=20,dy=11,dz=18]" | grep -q failed; then
   out=$(r "execute in minecraft:the_nether run summon minecraft:blaze -62.5 63.5 -41.5"); n=$((n+1)); last=$(date +%s)
   echo "$(date -u +%T) summon $n of $MAX: $out" >> "$LOG"
  fi
 fi
 sleep 10
done
echo "$(date -u +%T) range closed after $n summons" >> "$LOG"
