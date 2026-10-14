import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {attachTrail,wayBack} from '../src/trail.js'
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
function portalWorld(){
 // Portal at 0,61,0..1, standing cell beside it at -1,61,0. The bot's route went west
 // and down a staircase; from the bottom, the direct walk never finds its way back.
 const cells=new Map([['0,61,0','nether_portal'],['0,62,0','nether_portal']])
 // Bricks up to the route's floor: level to x -5, then down a block every two west, to y 57.
 const floor=x=>x>=-5?61:Math.max(57,61-Math.ceil((-5-x)/2))
 const name=p=>cells.get(key(p.floored()))??(Math.floor(p.y)<floor(Math.floor(p.x))?'nether_bricks':'air')
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
