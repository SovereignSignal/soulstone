import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {retreatToShelter} from '../src/retreat.js'
import {OwnBlocks,OWN_TTL_MS} from '../src/natural.js'
import minecraftData from 'minecraft-data'
const registry=minecraftData('1.21.4')
// Live, play world, 17 October 15:44Z and 16:04Z: at dusk the bot, walled in the night before by
// its own hut beside its base door, was refused its own base: "Shelter access obstructed by
// cobblestone at -624,68,-364". Those were its hut walls, recorded 23 hours earlier, past OWN_TTL_MS.
function base({record=null,inside=false,mouth=false,failMouth=false,swapOnEquip=false,noSpare=false,shaftBottom=false,missingRoof=false}={}){
 const o=new Vec3(0,64,0),design=[],world=new Map(),key=p=>p.toString(),dug=[],dugOpen=[];let open=false
 for(let x=0;x<=3;x++)for(let z=0;z<=3;z++)for(let y=0;y<=3;y++)if(y===3||((x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))){design.push({x,y,z,block:'wood_planks'});world.set(key(o.offset(x,y,z)),{name:'spruce_planks',boundingBox:'block'})}
 const torch=mouth?o.offset(2,0,2):inside?o.offset(2,0,1):o.offset(1,0,2)
 world.set(key(torch),{name:'torch',boundingBox:'empty'})
 // The hut's wall column on the doorstep, the door's two-cell approach. With
 // `inside`, the same hut column fills an interior column instead: the bot
 // walled in while standing in its own base (live, 18 October, see below).
 const wall=mouth?[o.offset(1,0,1),o.offset(1,1,1)]:inside?[o.offset(1,0,2),o.offset(1,1,2)]:[o.offset(1,0,-1),o.offset(1,1,-1)]
 for(const c of wall)world.set(key(c),{name:'cobblestone',boundingBox:'block'})
 if(inside)world.set(key(o.offset(1,-1,2)),{name:'air',boundingBox:'empty'})
 if(missingRoof)world.delete(key(o.offset(2,3,0)))
 const inventory=noSpare?[]:[{name:'cobblestone',count:4,type:registry.itemsByName.cobblestone.id}]
 const own=new OwnBlocks(null)
 if(record){for(const c of wall)own.add(c,record,null);for(const e of own.cells.values())e.at-=OWN_TTL_MS+60000}
 const bot={registry,entity:{position:o.offset(1.5,0,-2.5),onGround:true},world:{},ownBlocks:own,inventory:{items:()=>inventory},heldItem:null,equip:async item=>{bot.heldItem=item},placeBlock:async(ref,face)=>{world.set(key(ref.position.plus(face)),{name:'cobblestone',boundingBox:'block'})},
  blockAt:p=>{if(p.x===1&&p.z===0&&[64,65].includes(p.y))return {name:'spruce_door',position:p,boundingBox:'block',shapes:[[0,0,0,1,1,.2]],getProperties:()=>({open,half:p.y===64?'lower':'upper'})};return {...(world.get(key(p))||{name:p.y===63?'dirt':'air',boundingBox:p.y===63?'block':'empty'}),position:p,shapes:[]}},
  unequip:async()=>{},activateBlock:async()=>{open=!open},
  // As the live bot: the dug cell turns to air and its blockUpdate forgets the record (trackOwnPlacements).
  ...(swapOnEquip?{tool:{equipForBlock:async b=>{world.set(key(b.position),{name:'chest',boundingBox:'block'})}}}:{}),
  dig:async b=>{if(failMouth&&b.position.equals(o.offset(1,0,1)))throw new Error('Digging aborted');dug.push(key(b.position));if(open)dugOpen.push(key(b.position));world.delete(key(b.position));own.forget(b.position,null)}}
 bot.world.getBlock=bot.blockAt
 const task={kind:'retreat',goal:{project:{build:{origin:o,design,wood:'spruce_log'},stations:{torch:{position:torch}},...(inside||shaftBottom?{backExit:{cell:o.offset(1,0,2),...(shaftBottom?{bottom:60}:{})}}:{})}}}
 const api={check(){},progress(){},settle:async fn=>assert.ok(fn()),walk:async g=>{
  // No teleporting through a solid mouth: the one-wide door's only orthogonal
  // interior neighbour is the mouth column, and every other interior column
  // sits diagonal past the sealed corner (review, 18 October).
  if(Number.isFinite(g.x)&&g.z>=1&&g.z<=2&&g.x>=1&&g.x<=2&&bot.entity.position.z<1&&(world.has(key(o.offset(1,0,1)))||world.has(key(o.offset(1,1,1)))))throw new Error('Navigation ended without reaching the target')
  if(Number.isFinite(g.x)&&Number.isFinite(g.y)&&Number.isFinite(g.z))bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);else bot.entity.position=o.offset(1.5,0,-.5)}}
 return {bot,task,api,dug,dugOpen,wall,own,isOpen:()=>open}
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
// Live, play world, 18 October 09:24Z: the doorway fixes above were deployed
// (sha256 matched) and the base still refused with the same words. The live
// cells were never on the doorstep: -624,68,-364 is relative (1,0,2), an
// interior column (and the back-exit shaft cell), filled when the bot hutted
// while standing in the neighbouring interior column. The own collection
// excluded the interior, so its own hut wall refused its own base for good.
test('a retreat whose interior column is blocked by its own cobblestone older than OWN_TTL_MS enters and digs it from inside',async()=>{
 const b=base({record:'cobblestone',inside:true})
 const r=await retreatToShelter(b.bot,b.task,b.api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.equal(b.isOpen(),false);assert.equal(r.capped,true,'the dug shaft cell is capped again')
 assert.deepEqual(b.dug,['(1, 65, 2)','(1, 64, 2)'],'its two hut walls, top first')
 assert.deepEqual(b.bot.entity.position,new Vec3(1.5,64,1.5))
})
test('a bot already inside its base digs its own interior hut wall instead of refusing its own shelter',async()=>{
 const b=base({record:'cobblestone',inside:true});b.bot.entity.position=new Vec3(2.5,64,2.5)
 const r=await retreatToShelter(b.bot,b.task,b.api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.equal(b.isOpen(),false);assert.equal(r.capped,true)
 assert.deepEqual(b.dug,['(1, 65, 2)','(1, 64, 2)'])
})
test('an interior block that is not its own still refuses the base, with nothing dug',async()=>{
 for(const record of [null,'dirt']){
  const b=base({record,inside:true})
  await assert.rejects(retreatToShelter(b.bot,b.task,b.api),/^Error: Shelter access obstructed by cobblestone at 1,64,2$/)
  assert.deepEqual(b.dug,[]);assert.equal(b.isOpen(),false)
 }
})
// Review of the interior fix, 18 October: the mouth column (the entry target
// itself) filled the same way must not be walked into with the door open.
test('a retreat whose entry column is blocked by its own cobblestone digs the mouth through the open doorway, then steps in',async()=>{
 const b=base({record:'cobblestone',mouth:true})
 const r=await retreatToShelter(b.bot,b.task,b.api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.equal(b.isOpen(),false)
 assert.deepEqual(b.dug,['(1, 65, 1)','(1, 64, 1)'])
 assert.deepEqual(b.dugOpen,['(1, 65, 1)','(1, 64, 1)'],'the mouth is dug through the doorway, the one open-door dig on entry')
 assert.deepEqual(b.bot.entity.position,new Vec3(1.5,64,1.5))
})
test('leaving digs its own interior hut wall with the door still shut',async()=>{
 const b=base({record:'cobblestone',inside:true});b.bot.entity.position=new Vec3(2.5,64,2.5)
 const r=await retreatToShelter(b.bot,{...b.task,kind:'leave_base'},b.api)
 assert.equal(r.receipt,'left_base_door_closed');assert.equal(b.isOpen(),false)
 assert.deepEqual(b.dug,['(1, 65, 2)','(1, 64, 2)']);assert.deepEqual(b.dugOpen,[],'nothing dug while the door stood open')
})
test('a bot already inside keeps the old refusal for its own blocks outside the door',async()=>{
 const b=base({record:'cobblestone'});b.bot.entity.position=new Vec3(1.5,64,1.5)
 await assert.rejects(retreatToShelter(b.bot,b.task,b.api),/^Error: Shelter access obstructed by cobblestone at 1,64,-1$/)
 assert.deepEqual(b.dug,[]);assert.equal(b.isOpen(),false)
})
// Review of the interior fix, round three (18 October): the cap, the recheck
// and the re-shut each get a failing-world test, not just a read of the code.
test('a shaft cap with no spare block leaves the shaft open and the retreat sheltered',async()=>{
 const b=base({record:'cobblestone',inside:true,noSpare:true})
 const r=await retreatToShelter(b.bot,b.task,b.api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.equal(r.capped,undefined);assert.equal(b.isOpen(),false)
 assert.deepEqual(b.dug,['(1, 65, 2)','(1, 64, 2)'])
})
test('a block swapped during the tool equip is rechecked and never dug',async()=>{
 const b=base({record:'cobblestone',swapOnEquip:true})
 await assert.rejects(retreatToShelter(b.bot,b.task,b.api),/^Error: Shelter access obstructed by chest at 1,65,-1$/)
 assert.deepEqual(b.dug,[])
})
test('a mouth dig that fails shuts the door again before refusing',async()=>{
 const b=base({record:'cobblestone',mouth:true,failMouth:true})
 await assert.rejects(retreatToShelter(b.bot,b.task,b.api),/Digging aborted/)
 assert.equal(b.isOpen(),false)
})
test('entering by the back exit still refuses its own interior blocks',async()=>{
 const b=base({record:'cobblestone',inside:true,shaftBottom:true});b.bot.entity.position=new Vec3(2.5,60,2.5)
 await assert.rejects(retreatToShelter(b.bot,b.task,b.api),/^Error: Shelter access obstructed by cobblestone at 1,64,2$/)
 assert.deepEqual(b.dug,[])
})
// Live, play world, 18 October 17:40Z: with one roof block gone, leave_base
// swallowed the structure error as damage before the own collection ran, so
// the interior hut wall was never dug and the walk out had no path.
test('leaving a damaged base still digs its own interior hut wall and reports the damage',async()=>{
 const b=base({record:'cobblestone',inside:true,missingRoof:true});b.bot.entity.position=new Vec3(2.5,64,2.5)
 const r=await retreatToShelter(b.bot,{...b.task,kind:'leave_base'},b.api)
 assert.equal(r.receipt,'left_base_door_closed');assert.equal(b.isOpen(),false)
 assert.deepEqual(b.dug,['(1, 65, 2)','(1, 64, 2)'])
 assert.match(r.damage||'',/missing or changed at \(2, 67, 0\)/)
})
