#!/bin/bash
# Test world only, added 10 October (run 106): reset the portal bridge area before a staged run
# without the bot there. Force-loads the area, removes cobblestone left by earlier portal rooms,
# items on the ground, and the non-blaze hostiles the range clears, then unloads it.
# Settings, from the environment (defaults are the lab's):
#   MC_CONTAINER  the test world's Docker container (rcon-cli runs inside it)
#   MC_BOT        the bot's player name
MC_CONTAINER=${MC_CONTAINER:-mc-sandbox} MC_BOT=${MC_BOT:-SoulStone303}
r(){ docker exec "$MC_CONTAINER" rcon-cli "$1"; }
r "execute in minecraft:the_nether run forceload add -80 -50 -50 -30" > /dev/null; sleep 3
r "execute in minecraft:the_nether run fill -75 60 -45 -64 63 -37 minecraft:air replace minecraft:cobblestone"
r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=item,distance=..48]"
# zombie added 13 October (run 119: a zombie 4 blocks off at arrival sent the bot straight home; too close to wall in).
for t in hoglin magma_cube zombie; do r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=$t,distance=..24]"; done
for t in wither_skeleton skeleton; do r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=$t,distance=..40]"; done
# Blazes left by earlier ranges never despawn and piled up run on run (13 October, lab-1: 5, 7
# and 9 at staging, against 3 to 5 on the VM). Keep the 3 nearest the portal.
n=$(r "execute in minecraft:the_nether positioned -69 61 -41 if entity @e[type=blaze,distance=..48]" | grep -o 'Count: [0-9]*' | grep -o '[0-9]*')
if [ "${n:-0}" -gt 3 ]; then r "execute in minecraft:the_nether positioned -69 61 -41 run kill @e[type=blaze,distance=..48,sort=furthest,limit=$((n-3))]"; fi
r "execute in minecraft:the_nether run forceload remove -80 -50 -50 -30" > /dev/null
