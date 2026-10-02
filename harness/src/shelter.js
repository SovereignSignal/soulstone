import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
const key=p=>`${p.x},${p.y},${p.z}`
const clearable=new Set(['dirt','grass_block','sand','red_sand','gravel','snow','short_grass','tall_grass','fern'])
export function shelterLayout(design) {
 const map=new Map(design.map(b=>[key(b),b.block]))
 const xs=design.map(b=>b.x),zs=design.map(b=>b.z)
 const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs),roof=Math.max(...design.map(b=>b.y))
 if(maxX-minX<3||maxZ-minZ<3||roof<2)throw new Error('Shelter needs at least a 2 by 2 clear interior and two blocks of headroom')
 const inside=[],openings=[]
 for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){
  if(!map.has(key({x,y:roof,z})))throw new Error('Shelter roof is incomplete')
  const edge=x===minX||x===maxX||z===minZ||z===maxZ
  if(!edge){for(let y=0;y<roof;y++)if(map.has(key({x,y,z})))throw new Error('Shelter interior is obstructed by its design');inside.push(new Vec3(x,0,z));continue}
  const absent=[];for(let y=0;y<roof;y++)if(!map.has(key({x,y,z})))absent.push(y)
  if(!absent.length)continue
  if(absent.join(',')!=='0,1'||(x===minX||x===maxX)&&(z===minZ||z===maxZ))throw new Error('Shelter walls must enclose the interior with one two-block-high doorway')
  openings.push(new Vec3(x,0,z))
 }
 if(openings.length!==1)throw new Error('Shelter needs exactly one single-width doorway')
 const door=openings[0],out=new Vec3(door.x===minX?-1:door.x===maxX?1:0,0,door.z===minZ?-1:door.z===maxZ?1:0)
 const across=new Vec3(out.z,0,-out.x),approach=[]
 for(let depth=1;depth<=3;depth++)for(let side=-1;side<=1;side++)approach.push(door.plus(out.scaled(depth)).plus(across.scaled(side)))
 return {minX,maxX,minZ,maxZ,roof,door,out,inside,approach}
}
// Construction clearance is wider than the access an occupied base needs.
export const shelterAccessLayout=layout=>({...layout,approach:layout.approach.filter(p=>Math.abs(p.x-layout.door.x)+Math.abs(p.z-layout.door.z)<=2&&(layout.out.x?p.z===layout.door.z:p.x===layout.door.x))})
// `support`, when given, collects the floor cells that are missing instead of
// refusing the site: rebuilding a base a creeper cratered has to be able to put
// its own ground back. A new site is never chosen that way.
export function inspectShelterSite(bot,origin,layout,{repair=false,support=null}={}) {
 const remove=[]
 for(const rel of [...layout.inside,layout.door,...layout.approach]) {
  const p=origin.plus(rel),floor=bot.blockAt(p.offset(0,-1,0))
  if(floor?.boundingBox!=='block'){
   if(!support||!floor)throw new Error(`Shelter floor or approach lacks support at ${key(p)}`)
   if(!support.some(q=>q.equals(p.offset(0,-1,0))))support.push(p.offset(0,-1,0))
  }
  for(let y=0;y<2;y++){
   const b=bot.blockAt(p.offset(0,y,0))
   if(!b)throw new Error('Shelter inspection needs loaded terrain')
   if(b.name==='air'||b.name==='torch'||b.name==='wall_torch'||b.name==='wall_torch'||rel===layout.door&&/_door$/.test(b.name)&&!b.name.startsWith('iron'))continue
   if(repair&&layout.approach.includes(rel)&&clearable.has(b.name))remove.push(b.position.clone())
   else throw new Error(`Shelter access obstructed by ${b.name} at ${key(b.position)}`)
  }
 }
 return remove
}
export async function finishShelter(bot,origin,layout,wood,api) {
 const {check,walk,settle,acquire,progress,stage,persist}=api
 const cleared=[]
 // Re-observe after every dig, including falling sand/gravel. Never clear a
 // wall, unknown block, player build or more than the nine-cell approach.
 for(let pass=0;pass<5;pass++){
  const pending=inspectShelterSite(bot,origin,layout,{repair:true}).sort((a,b)=>b.y-a.y)
  if(!pending.length)break
  for(const p of pending){
   check();const b=bot.blockAt(p);if(b?.name==='air')continue
   if(!clearable.has(b?.name))throw new Error('Approach changed; refusing to clear an unexpected block')
   if(Object.values(bot.players||{}).some(v=>v.entity&&v.entity!==bot.entity&&v.entity.position.distanceTo(p)<1.5))throw new Error('A player is standing in the approach repair area')
   if(!bot.canDigBlock(b))await walk(new goals.GoalLookAtBlock(p,bot.world))
   check();progress('Clearing the shelter entrance');stage('digging');await bot.dig(bot.blockAt(p));check();await bot.waitForTicks(4)
   cleared.push({x:p.x,y:p.y,z:p.z});persist()
  }
 }
 inspectShelterSite(bot,origin,layout)
 const door=origin.plus(layout.door),outside=door.plus(layout.out.scaled(2)),inside=door.minus(layout.out)
 const name=wood.replace('_log','_door')
 if(bot.blockAt(door)?.name==='air') {
  await acquire(name,1);await walk(new goals.GoalBlock(outside.x,outside.y,outside.z));check()
  await bot.equip(bot.inventory.items().find(i=>i.name===name),'hand');check();stage('placing')
  await bot.placeBlock(bot.blockAt(door.offset(0,-1,0)),new Vec3(0,1,0));check()
 }
 const halves=()=>[bot.blockAt(door),bot.blockAt(door.offset(0,1,0))]
 await settle(()=>halves().every(b=>b?.name===name)&&halves()[0].getProperties().half==='lower'&&halves()[1].getProperties().half==='upper','Door halves were not confirmed')
 const opened=()=>halves().every(b=>b.getProperties().open===true)
 async function toggle(open) {
  check();if(opened()===open&&halves().every(b=>b.getProperties().open===open))return
  // Empty hand prevents accidentally placing another block while interacting.
  // When `use` lands, bare-hand becomes an explicit variant of this path, not an invariant of it.
  await bot.unequip('hand');check();await bot.activateBlock(bot.blockAt(door));check()
  await settle(()=>halves().every(b=>b.getProperties().open===open),`Door did not ${open?'open':'close'}`)
 }
 const visits=[]
 async function visit(p,label){await walk(new goals.GoalBlock(p.x,p.y,p.z));check();if(bot.entity.position.distanceTo(p.offset(.5,0,.5))>0.9)throw new Error(`Shelter walkthrough missed ${label}`);visits.push({label,position:bot.entity.position.clone()});progress(`Shelter checked: ${label}`)}
 await visit(outside,'outside approach');await toggle(false);await toggle(true)
 await visit(inside,'entered through door')
 for(const p of layout.inside)await visit(origin.plus(p),'interior floor')
 await visit(inside,'inside doorway');await toggle(false);await toggle(true)
 await visit(outside,'exited through door');await toggle(false)
 inspectShelterSite(bot,origin,layout)
 return {status:'usable',interiorCells:layout.inside.length,headroom:layout.roof,door:{position:door,name,closed:true},cleared,visits}
}
