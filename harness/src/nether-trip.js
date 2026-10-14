// A Nether trip: in the Nether, on a request, carrying the kit the fight rules need,
// and not hurt. On a trip the bot fights or takes cover where it stands; the portal is
// for going home hurt or with what it came for. Step 4, lab runs 129 to 137 (13
// October): the planner said walk 47 blocks to the spawner while the Nether safety
// rule sent the bot home at any hostile within ten blocks, and a fortress always has
// one; it never got twenty blocks in, and died retreating through the corridors.
import {armorPoints,meleeWeapon,meleeDamage} from './combat.js'
import {inNether} from './dimension.js'
// The same lines the heavy-mob fight rules use (combat.js), plus arrows for the blazes.
export const TRIP_ARMOR=14,TRIP_DAMAGE=6,TRIP_ARROWS=16,TRIP_HEALTH=12
export function tripKit(bot){
 const items=bot?.inventory?.items?.()||[]
 const bow=items.some(i=>i.name==='bow'),arrows=items.filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)
 const weapon=meleeWeapon(bot),armour=armorPoints(bot),missing=[]
 if(!bow)missing.push('a bow')
 if(arrows<TRIP_ARROWS)missing.push(`${TRIP_ARROWS} arrows (carrying ${arrows})`)
 if(!weapon||meleeDamage(weapon.name)<TRIP_DAMAGE)missing.push('an iron sword or axe')
 if(armour<TRIP_ARMOR)missing.push(`iron armour (${armour} of ${TRIP_ARMOR} points worn)`)
 return {ready:!missing.length,missing,arrows,armour,weapon:weapon?.name||null}
}
export function onTrip(bot,requestActive){
 return !!requestActive&&inNether(bot)&&Number.isFinite(bot?.health)&&bot.health>=TRIP_HEALTH&&tripKit(bot).ready
}
