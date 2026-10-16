import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {attachTrail,wayBack,standingGround} from '../src/trail.js'
import {usePortal} from '../src/portal-guard.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const key=p=>`${p.x},${p.y},${p.z}`
// Lab run 129 (13 October): eight seconds from the portal the bot was a level
// below the fortress bridge; the walk back, a route it had just walked, failed on the
// pathfinder's think limit and it drifted deeper in. The way back is the way it came.
function walker(dimension='the_nether'){
 const bot=new EventEmitter()
 Object.assign(bot,{game:{dimension:`minecraft:${dimension}`},entity:{position:new Vec3(.5,61,.5),onGround:true}})
 const to=(x,y,z,onGround=true)=>{bot.entity.position=new Vec3(x+.5,y,z+.5);bot.entity.onGround=onGround;bot.emit('move')}
 return {bot,to}
}
test('the trail keeps a crumb every two blocks on the ground, and starts again in each dimension',()=>{
 const {bot,to}=walker(),trail=attachTrail(bot)
 to(0,61,0);to(1,61,0);to(2,61,0);to(3,61,0);to(4,61,0)
 assert.deepEqual(trail.crumbs.map(key),['0,61,0','2,61,0','4,61,0'])
 to(6,63,0,false);assert.equal(trail.crumbs.length,3,'mid-jump is not ground to come back by')
 bot.game.dimension='minecraft:overworld';to(100,70,100)
 assert.equal(trail.dimension,'overworld');assert.deepEqual(trail.crumbs.map(key),['100,70,100'])
 for(let i=1;i<=700;i++)to(100+2*i,70,100)
 assert.equal(trail.crumbs.length,500,'bounded');assert.equal(trail.crumbs[0].x,502,'oldest dropped first: 701 crumbs, 201 gone')
 // A reconnect makes a new bot object; handed the old trail, it carries on from it.
 const again=walker('overworld');attachTrail(again.bot,{trail});again.to(1504,70,100)
 assert.equal(trail.crumbs.length,500);assert.equal(trail.crumbs.at(-1).x,1504);assert.equal(again.bot.trail,trail)
})
test('the way back starts from the crumb nearest the bot, so a loop it walked is cut short',()=>{
 const {bot,to}=walker(),trail=attachTrail(bot)
 for(const [x,z] of [[0,0],[2,0],[4,0],[4,2],[4,4],[2,4],[0,4],[0,2]])to(x,61,z)
 // Partway round: back the way it came, newest crumb first.
 assert.deepEqual(wayBack(trail,new Vec3(4,61,3)).map(key),['4,61,2','4,61,0','2,61,0','0,61,0'])
 // Round the loop and beside the start: one step, not the whole loop backwards.
 assert.deepEqual(wayBack(trail,new Vec3(0,61,1)).map(key),['0,61,0'])
 assert.deepEqual(wayBack({crumbs:[]},new Vec3(0,61,0)),[])
})
// Rehearsal, 16 October 23:12Z: the bot went out from the portal along its tunnels to a
// blaze spawner, came most of the way back along the same tunnels, then bored a new
// tunnel west. The trail held the whole trip; the way back reversed all of it, so the
// retrace walked out to the spawner first. The live shape, scaled down: out west, south,
// west to the far end; back east, north partway, then west into a new tunnel.
function doubledBack(to){
 const line=(a,b)=>{const out=[],[dx,dz]=[Math.sign(b[0]-a[0]),Math.sign(b[1]-a[1])];for(let [x,z]=a;x!==b[0]||z!==b[1];x+=dx,z+=dz)out.push([x,z]);return out}
 const legs=[[[-1,0],[-10,0]],[[-10,0],[-10,10]],[[-10,10],[-20,10]],[[-20,10],[-10,10]],[[-10,10],[-10,5]],[[-10,5],[-16,5]]]
 for(const [a,b] of legs)for(const [x,z] of line(a,b))to(x,61,z)
 to(-16,61,5)
}
test('a trail that went out and doubled back is walked the short way home, never out to its far end',()=>{
 const {bot,to}=walker(),trail=attachTrail(bot);doubledBack(to)
 const route=wayBack(trail,new Vec3(-16,61,5))
 assert.equal(key(route[0]),'-16,61,5','starts at the crumb the bot stands on')
 assert.equal(key(route.at(-1)),'-1,61,0','ends where the trail began, beside the portal')
 assert.ok(route.every(c=>c.z<=6&&c.x>=-16),'never back out toward the far end: '+route.map(key).join(' '))
 const length=route.slice(1).reduce((sum,c,i)=>sum+c.distanceTo(route[i]),0)
 assert.ok(length<=6+5+9+2,`the short way along the trail, ${length.toFixed(1)} blocks`)
 // Every step brings it nearer the portal end along the trail: no crumb comes twice.
 assert.equal(new Set(route.map(key)).size,route.length)
})
test('the way back ends at the portal or refuses, and never steps on ground that is gone',()=>{
 const {bot,to}=walker(),trail=attachTrail(bot)
 for(let x=-1;x>=-20;x--)to(x,61,0)
 const portal=[new Vec3(0,61,0)],from=new Vec3(-20,61,0)
 // A straight trail is walked back newest first, as before.
 assert.deepEqual(wayBack(trail,from,{to:portal}).map(c=>c.x),[-19,-17,-15,-13,-11,-9,-7,-5,-3,-1])
 // A crumb whose floor is gone breaks the only way back: refuse, naming it.
 const hole=c=>!(c.x===-9&&c.z===0)
 assert.throws(()=>wayBack(trail,from,{to:portal,usable:hole}),/broken at -9,61,0/)
 // A trail that began away from the portal (a restart mid-trip) does not lead to it.
 const late={dimension:'the_nether',crumbs:trail.crumbs.slice(5)}
 assert.throws(()=>wayBack(late,from,{to:portal}),/does not reach back to the portal/)
})
test('standing ground: a crumb is no good once its floor is gone, lava is in it, or its head space is filled',()=>{
 const cells=new Map([['0,60,0','netherrack'],['1,60,0','air'],['2,60,0','lava'],['3,60,0','netherrack'],['3,62,0','cobblestone'],['4,60,0','netherrack'],['4,61,0','lava'],['5,61,0','soul_sand'],['6,60,0','stone'],['6,61,0','oak_door'],['6,62,0','oak_door']])
 const bot={registry,blockAt(p){const name=cells.get(key(p))??'air',b=Block.fromStateId(registry.blocksByName[name].defaultState,0);b.position=p;return b}}
 assert.equal(standingGround(bot,new Vec3(0,61,0)),true,'on netherrack')
 assert.equal(standingGround(bot,new Vec3(1,61,0)),false,'open air, no floor')
 assert.equal(standingGround(bot,new Vec3(2,61,0)),false,'lava for a floor')
 assert.equal(standingGround(bot,new Vec3(3,61,0)),false,'a plug where the head goes')
 assert.equal(standingGround(bot,new Vec3(4,61,0)),false,'lava where the feet go')
 assert.equal(standingGround(bot,new Vec3(5,61,0)),true,'standing in a soul sand cell, on it')
 assert.equal(standingGround(bot,new Vec3(6,61,0)),true,'in a doorway it walked through')
 assert.equal(standingGround({blockAt:()=>null},new Vec3(0,61,0)),true,'unloaded ground is no evidence against')
})
function portalWorld({floor=x=>x>=-5?61:Math.max(57,61-Math.ceil((-5-x)/2)),holes=[]}={}){
 // Portal at 0,61,0..1, standing cell beside it at -1,61,0. The bot's route went west
 // and down a staircase; from the bottom, the direct walk never finds its way back.
 const cells=new Map([['0,61,0','nether_portal'],['0,62,0','nether_portal']])
 // Bricks up to the route's floor (by default level to x -5, then down a block every two
 // west, to y 57); a hole is a column with nothing under the floor's level.
 const gone=p=>holes.some(([x,z])=>x===Math.floor(p.x)&&z===Math.floor(p.z))
 const name=p=>cells.get(key(p.floored()))??(Math.floor(p.y)<floor(Math.floor(p.x))&&!gone(p)?'nether_bricks':'air')
 const bot=new EventEmitter(),log=[]
 Object.assign(bot,{registry,players:{},entities:{},health:20,food:20,game:{gameMode:'survival',difficulty:'normal',dimension:'minecraft:the_nether'},inventory:{items:()=>[]},
  entity:{position:new Vec3(-.5,61,.5),onGround:true,metadata:{0:0},effects:[]},
  blockAt(p){const b=Block.fromStateId(registry.blocksByName[name(p)].defaultState,0);b.position=p.floored();return b},
  findBlock:({maxDistance})=>bot.entity.position.distanceTo(new Vec3(0,61,0))<=maxDistance?bot.blockAt(new Vec3(0,61,0)):null,
  async lookAt(p){bot.lookTarget=p},clearControlStates(){},
  setControlState(k,v){if(k==='jump')bot.entity.onGround=!v;if(k==='forward'&&v&&bot.lookTarget){const t=bot.lookTarget.floored();bot.entity.position=new Vec3(t.x+.5,t.y,t.z+.5);if(t.x===0&&!bot.crossed){bot.crossed=true;setTimeout(()=>{bot.game.dimension='minecraft:overworld';log.push('crossed')},10)}}}})
 const move=(x,y,z)=>{bot.entity.position=new Vec3(x+.5,y,z+.5);bot.entity.onGround=true;bot.emit('move')}
 // A pathfinder that plans only short hops: anything over 5 blocks away times out.
 bot.pathfinder={setGoal(){},setMovements(){},async goto(g){
  const t=new Vec3(g.x,g.y,g.z),d=t.distanceTo(bot.entity.position.floored())
  log.push(`goto ${key(t)}${g.rangeSq!==undefined?' near':''}`)
  if(d>5)throw new Error('Took to long to decide path to goal!')
  move(t.x,t.y,t.z)}}
 return {bot,log,move}
}
test('when the direct walk to the portal fails, the bot retraces its trail and goes home',async()=>{
 const w=portalWorld();attachTrail(w.bot)
 const route=[[-1,61,0],[-3,61,0],[-5,61,0],[-7,60,0],[-9,59,0],[-11,58,0],[-13,57,0],[-15,57,2],[-15,57,4]]
 for(const c of route)w.move(...c)
 const result=await usePortal(w.bot,{kind:'use_portal',goal:{}},{check(){},stage(){},progress(m){w.log.push('say '+m)}},{pollMs:5,hopMs:5})
 assert.equal(result.receipt,'crossed')
 const hops=w.log.filter(l=>/ near$/.test(l))
 assert.ok(hops.length>=4,'walked back crumb by crumb: '+w.log.join(' | '))
 assert.ok(w.log.some(l=>/Retracing my steps/.test(l)))
})
test('with no trail in this dimension, a failed walk to the portal still refuses the blind step',async()=>{
 const w=portalWorld();attachTrail(w.bot)
 w.bot.game.dimension='minecraft:overworld';w.move(-15,57,4);w.bot.game.dimension='minecraft:the_nether'
 w.bot.entity.position=new Vec3(-14.5,57,4.5)
 await assert.rejects(usePortal(w.bot,{kind:'use_portal',goal:{}},{check(){},stage(){},progress(){}},{pollMs:5,hopMs:5}),/did not reach a standing cell beside the portal/)
})
test('a doubled-back trail retraces to the portal, not out to the far end of the trip',async()=>{
 const w=portalWorld({floor:()=>61});attachTrail(w.bot)
 doubledBack((x,y,z)=>w.move(x,y,z))
 const start=w.bot.entity.position.floored().distanceTo(new Vec3(0,61,0))
 const result=await usePortal(w.bot,{kind:'use_portal',goal:{}},{check(){},stage(){},progress(m){w.log.push('say '+m)}},{pollMs:5,hopMs:5})
 assert.equal(result.receipt,'crossed')
 const hops=w.log.filter(l=>/ near$/.test(l)).map(l=>l.split(' ')[1].split(',').map(Number))
 assert.ok(hops.length>=4,'walked back crumb by crumb: '+w.log.join(' | '))
 assert.ok(hops.every(([x,y,z])=>Math.hypot(x,z)<=start),'every hop no farther from the portal than where it started: '+w.log.join(' | '))
})
test('a straight trail still retraces newest crumb first, each hop nearer the portal',async()=>{
 const w=portalWorld({floor:()=>61});attachTrail(w.bot)
 for(let x=-1;x>=-20;x--)w.move(x,61,0)
 const result=await usePortal(w.bot,{kind:'use_portal',goal:{}},{check(){},stage(){},progress(m){w.log.push('say '+m)}},{pollMs:5,hopMs:5})
 assert.equal(result.receipt,'crossed')
 const hops=w.log.filter(l=>/ near$/.test(l)).map(l=>Number(l.split(' ')[1].split(',')[0]))
 assert.deepEqual(hops,[-19,-17,-15,-13,-11,-9,-7,-5])
})
test('a retrace never steps onto a crumb whose floor has fallen away; it stops and says where',async()=>{
 const w=portalWorld({floor:()=>61});attachTrail(w.bot)
 for(let x=-1;x>=-20;x--)w.move(x,61,0)
 // Since it passed, the floor under -9,61,0 fell away.
 const world=portalWorld({floor:()=>61,holes:[[-9,0]]});w.bot.blockAt=world.bot.blockAt
 await assert.rejects(usePortal(w.bot,{kind:'use_portal',goal:{}},{check(){},stage(){},progress(m){w.log.push('say '+m)}},{pollMs:5,hopMs:5}),/will not retrace.*broken at -9,61,0/)
 assert.ok(!w.log.some(l=>/^goto -9,61,0/.test(l)),'never onto the hole: '+w.log.join(' | '))
 assert.ok(!w.log.includes('crossed'))
})
test('a trail that does not reach the portal (begun mid-trip, after a restart) is not walked',async()=>{
 const w=portalWorld({floor:()=>61})
 const trail=attachTrail(w.bot);for(let x=-1;x>=-20;x--)w.move(x,61,0)
 trail.crumbs.splice(0,6)
 await assert.rejects(usePortal(w.bot,{kind:'use_portal',goal:{}},{check(){},stage(){},progress(m){w.log.push('say '+m)}},{pollMs:5,hopMs:5}),/will not retrace.*does not reach back to the portal/)
 assert.ok(!w.log.some(l=>/ near$/.test(l)),'no hop toward the trail start: '+w.log.join(' | '))
})
