#!/bin/bash
# Logs blaze rods lying on or over the portal bridge every 2 s, and fire blocks at bridge level. rod-watch.sh <log> <minutes>
# Settings, from the environment (defaults are the lab's):
#   MC_CONTAINER  the test world's Docker container (rcon-cli runs inside it)
#   MC_BOT        the bot's player name
MC_CONTAINER=${MC_CONTAINER:-mc-sandbox} MC_BOT=${MC_BOT:-SoulStone303}
r(){ docker exec "$MC_CONTAINER" rcon-cli "$1"; }
end=$(( $(date +%s) + $2*60 ))
while [ "$(date +%s)" -lt "$end" ]; do
 o=$(r "execute in minecraft:the_nether positioned -62 61 -41 as @e[type=item,distance=..30] run data get entity @s Pos" | tr -d "\r")
 i=$(r "execute in minecraft:the_nether positioned -62 61 -41 as @e[type=item,distance=..30] run data get entity @s Item.id" | tr -d "\r")
 case "$i" in *blaze_rod*) echo "$(date -u +%T) ITEMS $i | $o" >> "$1";; esac
 f=$(r "execute in minecraft:the_nether if blocks -76 61 -45 -56 61 -37 -76 100 -45 all" 2>/dev/null)
 sleep 2
done
