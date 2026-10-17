import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {retreatToShelter} from '../src/retreat.js'
import {OwnBlocks,OWN_TTL_MS} from '../src/natural.js'
// Live, play world, 17 October 15:44Z and 16:04Z: at dusk the bot, walled in the night before by
// its own hut beside its base door, was refused its own base: "Shelter access obstructed by
// cobblestone at -624,68,-364". Those were its hut walls, recorded 23 hours earlier, past OWN_TTL_MS.
function base({record=null}={}){
 const o=new Vec3(0,64,0),design=[],world=new Map(),key=p=>p.toString(),dug=[];let open=false
 for(let x=0;x<=3;x++)for(let z=0;z<=3;z++)for(let y=0;y<=3;y++)if(y===3||((x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))){design.push({x,y,z,block:'wood_planks'});world.set(key(o.offset(x,y,z)),{name:'spruce_planks',boundingBox:'block'})}
 world.set(key(o.offset(1,0,2)),{name:'torch',boundingBox:'empty'})
 // The hut's wall column on the doorstep, the door's two-cell approach.
 const wall=[o.offset(1,0,-1),o.offset(1,1,-1)]
 for(const c of wall)world.set(key(c),{name:'cobblestone',boundingBox:'block'})
 const own=new OwnBlocks(null)
 if(record){for(const c of wall)own.add(c,record,null);for(const e of own.cells.values())e.at-=OWN_TTL_MS+60000}
 const bot={registry:{blocksByName:{torch:{emitLight:14}}},entity:{position:o.offset(1.5,0,-2.5),onGround:true},world:{},ownBlocks:own,
  blockAt:p=>{if(p.x===1&&p.z===0&&[64,65].includes(p.y))return {name:'spruce_door',position:p,boundingBox:'block',shapes:[[0,0,0,1,1,.2]],getProperties:()=>({open,half:p.y===64?'lower':'upper'})};return {...(world.get(key(p))||{name:p.y===63?'dirt':'air',boundingBox:p.y===63?'block':'empty'}),position:p,shapes:[]}},
  unequip:async()=>{},activateBlock:async()=>{open=!open},
  // As the live bot: the dug cell turns to air and its blockUpdate forgets the record (trackOwnPlacements).
  dig:async b=>{dug.push(key(b.position));world.delete(key(b.position));own.forget(b.position,null)}}
 bot.world.getBlock=bot.blockAt
 const task={kind:'retreat',goal:{project:{build:{origin:o,design,wood:'spruce_log'},stations:{torch:{position:o.offset(1,0,2)}}}}}
 const api={check(){},progress(){},settle:async fn=>assert.ok(fn()),walk:async g=>{if(Number.isFinite(g.x)&&Number.isFinite(g.y)&&Number.isFinite(g.z))bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);else bot.entity.position=o.offset(1.5,0,-.5)}}
 return {bot,task,api,dug,wall,own,isOpen:()=>open}
}
test('a retreat whose doorstep is blocked by its own cobblestone older than OWN_TTL_MS digs it and enters',async()=>{
 const b=base({record:'cobblestone'})
 const r=await retreatToShelter(b.bot,b.task,b.api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.equal(b.isOpen(),false)
 assert.deepEqual(b.dug,['(1, 65, -1)','(1, 64, -1)'],'its two hut walls, top first')
 assert.deepEqual(b.bot.entity.position,new Vec3(1.5,64,1.5))
})
test('the same cobblestone unrecorded, or recorded as another block, is a player\'s and still blocks the retreat',async()=>{
 const player=base()
 await assert.rejects(retreatToShelter(player.bot,player.task,player.api),/^Error: Shelter access obstructed by cobblestone at 1,64,-1$/)
 assert.deepEqual(player.dug,[]);assert.equal(player.isOpen(),false)
 const changed=base({record:'dirt'})
 await assert.rejects(retreatToShelter(changed.bot,changed.task,changed.api),/Shelter access obstructed by cobblestone at 1,64,-1/)
 assert.deepEqual(changed.dug,[])
})
// Review of 403c76e, 17 October: released by day from inside the base, leave_base never dug the bot's own
// hut wall on the doorstep (leaving swallowed the obstruction as damage) and walked into it.
test('leaving the base by a doorstep blocked by its own old cobblestone digs it through the open door and goes out',async()=>{
 const b=base({record:'cobblestone'});b.bot.entity.position=new Vec3(1.5,64,1.5)
 const r=await retreatToShelter(b.bot,{...b.task,kind:'leave_base'},b.api)
 assert.equal(r.receipt,'left_base_door_closed');assert.equal(b.isOpen(),false)
 assert.deepEqual(b.dug,['(1, 65, -1)','(1, 64, -1)'],'its two hut walls, top first')
 assert.deepEqual(b.bot.entity.position,new Vec3(1.5,64,-1.5))
})
test('leaving by a doorstep blocked by cobblestone that is not its own refuses before the door opens',async()=>{
 for(const record of [null,'dirt']){
  const b=base({record});b.bot.entity.position=new Vec3(1.5,64,1.5)
  await assert.rejects(retreatToShelter(b.bot,{...b.task,kind:'leave_base'},b.api),/^Error: Shelter access obstructed by cobblestone at 1,64,-1$/)
  assert.deepEqual(b.dug,[]);assert.equal(b.isOpen(),false);assert.deepEqual(b.bot.entity.position,new Vec3(1.5,64,1.5))
 }
})
