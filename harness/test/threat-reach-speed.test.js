import {test} from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {threatRoutes} from '../src/threat-reach.js'
const registry=minecraftData('1.21.4')
// Lab, 13 October: walled in at the fortress with nine blazes about, the flood
// ran every 500 ms of the clearance wait and every second of the survival tick, and on
// a Raspberry Pi it took a quarter of the bot's time (CPU profile of run 123). The
// bot's own tick ran up to 3 s late in fights and its shots came 4.5 s apart, not 2.
// The answers must not change, only what each one costs.
const STATES={air:0,stone:1,nether_bricks:2,oak_door:3,oak_door_open:4,water:5}
function cave({strip=true}={}){
 // A chamber of air 36 x 12 x 30 inside stone, a brick pillar, a corridor shut by a
 // closed door with a room behind it, one open door, a pool, and an unloaded strip.
 const name=p=>{
  const {x,y,z}=p
  if(y<60||y>71||x<-15||x>20||z<-15||z>14)return 'stone'
  if(x>=2&&x<=3&&z>=2&&z<=3)return 'nether_bricks'
  if(x===10&&z<=-5&&z>=-6&&y<=61)return 'water'
  if(z===8&&x===0&&y<=61)return 'oak_door'
  if(z===8)return 'stone'
  if(x===-8&&y<=61&&z===-12)return 'oak_door_open'
  return 'air'
 }
 // Ground loads by whole 16-block columns, so the unloaded strip starts at one.
 const unloaded=p=>strip&&p.x>=16
 const block=p=>{
  if(unloaded(p))return null
  const n=name(p),open=n==='oak_door_open',real=open?'oak_door':n
  return {name:real,position:p,getProperties:()=>(real==='oak_door'?{open}:{})}
 }
 let calls=0
 const slow={registry,game:{difficulty:'normal',minY:-64,height:384},entity:{position:new Vec3(-4.5,60,-4.5)},blockAt:p=>{calls++;return block(p)}}
 const fast={...slow,blockAt:p=>{calls++;return block(p)},world:{getColumnAt:p=>unloaded(p)?null:{},getBlockStateId:p=>unloaded(p)?0:STATES[name(p)]}}
 return {slow,fast,calls:()=>calls,reset:()=>{calls=0}}
}
const THREATS=[[-10,60,-10],[0,60,12],[6,60,6],[17,60,0],[10,60,-6],[-8,60,-13],[2,65,2],[14.5,66,14.5],[-14,71,14]].map(([x,y,z])=>({position:new Vec3(x+.5,y,z+.5)}))
test('the flood gives the same routes from block states as from blocks: open, sealed behind a shut door, unknown at unloaded ground',()=>{
 // Any unseen cell makes every hostile not found 'unknown', so 'sealed' needs a fully loaded cave.
 const answers=new Set()
 for(const strip of [true,false]){
  const c=cave({strip}),before=threatRoutes(c.slow,THREATS)
  assert.deepEqual(threatRoutes(c.fast,THREATS),before);before.forEach(r=>answers.add(r.reach))
 }
 assert.deepEqual([...answers].sort(),['open','sealed','unknown'],'the caves exercise all three answers')
 const w=cave()
 // From a shelter's exits too, and with a cell limit that cuts the search short.
 const exits=[new Vec3(-4,60,-4),new Vec3(5,60,5)]
 assert.deepEqual(threatRoutes(w.fast,THREATS,{origins:exits}),threatRoutes(w.slow,THREATS,{origins:exits}))
 assert.deepEqual(threatRoutes(w.fast,THREATS,{limit:500}),threatRoutes(w.slow,THREATS,{limit:500}))
})
test('with block states to hand, the flood builds one block per state seen, not one per cell',()=>{
 const w=cave()
 threatRoutes(w.slow,THREATS);const perCell=w.calls();w.reset()
 threatRoutes(w.fast,THREATS);const perState=w.calls()
 assert.ok(perCell>5000,`the cave is a real search (${perCell} cells)`)
 assert.ok(perState<=Object.keys(STATES).length,`${perState} block builds for ${Object.keys(STATES).length} states`)
})
