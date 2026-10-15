// A Nether trip: in the Nether, on a request, carrying the kit the fight rules need,
// and not hurt. On a trip the bot fights or takes cover where it stands; the portal is
// for going home hurt or with what it came for. Step 4, lab runs 129 to 137 (13
// October): the planner said walk 47 blocks to the spawner while the Nether safety
// rule sent the bot home at any hostile within ten blocks, and a fortress always has
// one; it never got twenty blocks in, and died retreating through the corridors.
import {armorPoints,meleeWeapon,meleeDamage,fightableAlone,ENGAGE_RANGE} from './combat.js'
import {SHOOTERS_ONLY,breachesRock,outOfReach,cannotShootYet,threatRadius,fireObservation} from './survival.js'
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
// On a trip, one mob the fight rule would take on alone, out of sight past arm's reach and
// not breaking through, is walked on: no alarm, no hut held for it. Lab run 148, 15 October:
// kitted at health 20, the bot held its portal-room hut fifteen minutes over a wither
// skeleton 11 blocks off behind netherrack, out of the fight rule's ten, no shooter for the
// bow, so cover was the only answer and it never changed. Lab run 142 had the kit beat a
// lone one at 18 health. In sight, within the fight rule's ten (a wither skeleton covers
// about four blocks a second and the tick is one a second, so the alarm, which fights it,
// takes it there), or with a second hostile counting, the alarm stands.
// threats: everything the alarm sees, to count the others by its own tests.
export function walkOnThreat(bot,t,threats){
 const counts=x=>x.risk==='potential_hostile'&&x.distance<=threatRadius(x.name)&&!outOfReach(x)&&!cannotShootYet(x)
 return t.risk==='potential_hostile'&&t.sightline?.status==='blocked'&&t.distance>ENGAGE_RANGE&&!SHOOTERS_ONLY.has(t.name)&&!breachesRock(t)&&
  fightableAlone(bot,t.name)&&counts(t)&&threats.filter(counts).length===1
}
// Lab run 156, 15 October: broken off at a firing port at 10 health and alight, the bot
// walled in and burned to death. A port opens toward a shooter only on health enough to take
// a fireball and its burn with room to break off (a blaze's 5 and a few seconds alight), not
// while burning, and with food enough to go on healing.
export const PORT_HEALTH=16,PORT_FOOD=6
export function portReady(bot){
 if(!Number.isFinite(bot?.health)||bot.health<PORT_HEALTH)return {ready:false,reason:`health ${Number.isFinite(bot?.health)?Math.round(bot.health*10)/10:'unknown'} of ${PORT_HEALTH}`}
 if(fireObservation(bot).onFire===true)return {ready:false,reason:'on fire'}
 if(!Number.isFinite(bot?.food)||bot.food<PORT_FOOD)return {ready:false,reason:`food ${Number.isFinite(bot?.food)?bot.food:'unknown'} of ${PORT_FOOD}`}
 return {ready:true}
}
// Lab run 156, 15 October: the port's kills fell in a sealed room beside the hut with three
// more blazes in it. On a trip the rods are walked for only once no shooter has been near for
// a minute, on 16 health or more, and only where they fell within eight blocks of the hut.
// sites: kill sites ({at}); hut: the shelter's feet cell; shooterSeenAt: ms, or none seen.
// Not while burning, either.
export const PICKUP={quietMs:60000,health:16,reach:8}
export const sitesNearHut=(hut,sites)=>hut?sites.filter(k=>Math.hypot(k.at.x-(hut.x+.5),k.at.y-hut.y,k.at.z-(hut.z+.5))<=PICKUP.reach):[]
export function tripPickup({health,onFire,shooterSeenAt,now,hut,sites=[]}){
 const no=reason=>({ok:false,reason,sites:[]})
 if(Number.isFinite(shooterSeenAt)&&now-shooterSeenAt<PICKUP.quietMs)return no(`a shooter was near ${Math.round((now-shooterSeenAt)/1000)} seconds ago`)
 if(!Number.isFinite(health)||health<PICKUP.health)return no(`health ${Number.isFinite(health)?Math.round(health*10)/10:'unknown'} of ${PICKUP.health}`)
 if(onFire)return no('on fire')
 const near=sitesNearHut(hut,sites)
 return near.length?{ok:true,sites:near}:no(`nothing fell within ${PICKUP.reach} blocks of the hut`)
}
