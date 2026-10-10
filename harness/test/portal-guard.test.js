import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from '../src/navigation.js'
import {survivalObservation,emergencyReason,PORTAL_EMERGENCY,FIRE_EMERGENCY} from '../src/survival.js'
import {leavePortal,usePortal} from '../src/portal-guard.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const key=p=>`${p.x},${p.y},${p.z}`

// Sov's limit: never step through a portal or enter the Nether. A player
// standing in a nether portal is carried there after four seconds.
function fixture(cells={}){
 const world=new Map(Object.entries(cells)),log=[]
 const name=p=>world.get(key(p.floored()))??(p.y<64?'stone':'air')
 const bot={registry,players:{},entities:{},health:20,food:20,game:{gameMode:'survival',difficulty:'hard'},inventory:{items:()=>[]},
  entity:{position:new Vec3(.5,64,.5),onGround:true,metadata:{0:0},effects:[]},pathfinder:{bestHarvestTool:()=>null,setGoal(){},setMovements(){},async goto(){}},
  blockAt(p){const b=Block.fromStateId(registry.blocksByName[name(p)].defaultState,0);b.position=p.floored();return b},
  async lookAt(p){bot.lookTarget=p},clearControlStates(){},
  setControlState(k,v){if(k==='jump')bot.entity.onGround=!v;if(k==='forward'&&v&&bot.lookTarget){const t=bot.lookTarget.floored();log.push('step '+key(t));bot.entity.position=new Vec3(t.x+.5,t.y,t.z+.5)}}}
 return {bot,world,log,api:{check(){},stage(){},progress(m){log.push('say '+m)},movements:null}}
}

test('no walk steps into a portal cell',()=>{
 const {bot}=fixture({'1,64,0':'nether_portal','1,65,0':'nether_portal'})
 const m=new DoorAwareMovements(bot)
 assert.ok(m.blocksToAvoid.has(registry.blocksByName.nether_portal.id))
 assert.ok(m.blocksToAvoid.has(registry.blocksByName.end_portal.id))
 const moves=m.getNeighbors({x:0,y:64,z:0,remainingBlocks:0})
 assert.ok(!moves.some(n=>n.x===1&&n.z===0&&n.y===64),'the portal cell is never a step')
 assert.ok(moves.some(n=>n.x===-1&&n.z===0),'other steps remain')
})

test('standing in a portal is the most urgent emergency there is',()=>{
 const {bot}=fixture({'0,64,0':'nether_portal','0,65,0':'nether_portal'})
 assert.equal(survivalObservation(bot).inPortal,true)
 bot.entity.metadata[0]=1
 assert.equal(emergencyReason(survivalObservation(bot)),PORTAL_EMERGENCY,'four seconds beats a fire')
 const {bot:clear}=fixture();clear.entity.metadata[0]=1
 assert.equal(emergencyReason(survivalObservation(clear)),FIRE_EMERGENCY)
})

test('leaving a portal steps straight out to a standing cell that is not portal',async()=>{
 const f=fixture({'0,64,0':'nether_portal','0,65,0':'nether_portal','0,64,1':'nether_portal','0,65,1':'nether_portal'})
 const r=await leavePortal(f.bot,{},f.api,{pollMs:1,stepMs:50})
 assert.equal(r.receipt,'out_of_portal')
 const p=f.bot.entity.position.floored()
 assert.notEqual(f.world.get(key(p)),'nether_portal')
 assert.ok(f.log.some(l=>l.startsWith('step')))
})

test('a portal it cannot get out of is a failure, never a success',async()=>{
 const f=fixture({'0,64,0':'nether_portal','0,65,0':'nether_portal'});f.bot.setControlState=()=>{}
 await assert.rejects(leavePortal(f.bot,{},f.api,{pollMs:1,stepMs:20}),/Still in the portal/)
})

// workstreams/minecraft/nether-plan.md, step 5: use_portal, the one deliberate
// way through, only where the world's switch allows the Nether. Coming home
// from the Nether is always allowed: turning the switch off never strands it.
function crossing(dimension,{carries=true}={}){
 const f=fixture({'2,64,0':'nether_portal','2,65,0':'nether_portal'})
 f.bot.game.dimension=`minecraft:${dimension}`
 f.bot.findBlock=({matching,maxDistance})=>{for(const k of ['2,64,0','2,65,0']){const [x,y,z]=k.split(',').map(Number),p=new Vec3(x,y,z);if([matching].flat().includes(registry.blocksByName.nether_portal.id)&&p.distanceTo(f.bot.entity.position)<=maxDistance)return f.bot.blockAt(p)}return null}
 f.bot.pathfinder.goto=async g=>{f.log.push('walk');f.bot.entity.position=new Vec3(1.5,64,0.5)}
 const step=f.bot.setControlState
 f.bot.setControlState=(k,v)=>{step(k,v);const p=f.bot.entity.position.floored();if(carries&&k==='forward'&&v&&p.x===2&&!f.crossed){f.crossed=true;setTimeout(()=>{f.bot.game.dimension=`minecraft:${dimension==='overworld'?'the_nether':'overworld'}`;f.log.push('crossed')},20)}}
 return f
}
test('use_portal walks in, crosses, steps out on the far side and records both portals',async()=>{
 const f=crossing('overworld')
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5})
 assert.equal(r.receipt,'crossed');assert.equal(r.from.dimension,'overworld');assert.equal(r.to.dimension,'the_nether')
 assert.deepEqual(r.from.portal,{x:2,y:64,z:0})
 assert.equal(survivalObservation(f.bot).inPortal,false,'stepped out of the arrival portal')
})
test('use_portal from the Overworld is refused while the switch is off; from the Nether it always goes home',async()=>{
 const off=crossing('overworld')
 await assert.rejects(usePortal(off.bot,{kind:'use_portal',goal:{}},{...off.api,netherAllowed:false},{pollMs:5}),/off for this world/)
 assert.ok(!off.log.includes('walk'),'not a step toward the portal')
 const home=crossing('the_nether')
 const r=await usePortal(home.bot,{kind:'use_portal',goal:{}},{...home.api,netherAllowed:false},{pollMs:5})
 assert.equal(r.to.dimension,'overworld')
})
test('a portal that does not carry the bot across is stepped back out of, and said so',async()=>{
 const f=crossing('overworld',{carries:false})
 await assert.rejects(usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5,crossMs:60,pauseMs:5}),/did not carry/)
 assert.equal(survivalObservation(f.bot).inPortal,false)
})

// Run 69, 8 October: the walk to the portal timed out short of it, and the
// last step "by direct control" walked the bot from there into a water hole,
// where it drowned. The blind step is taken only from a standing cell beside
// the portal; anywhere else use_portal stops with the reason.
test('use_portal steps in only from a standing cell beside the portal, never from wherever a walk stopped',async()=>{
 const f=crossing('overworld')
 f.bot.pathfinder.goto=async()=>{f.log.push('walk');throw new Error('Took to long to decide path to goal!')}
 f.bot.entity.position=new Vec3(-2.5,64,0.5)
 await assert.rejects(usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5}),/did not reach a standing cell beside the portal/)
 assert.ok(!f.log.some(l=>/^step /.test(l)),'no blind step: '+f.log.join(' | '))
 const g=crossing('overworld');let target
 g.bot.pathfinder.goto=async goal=>{target=[goal.x,goal.y,goal.z];g.bot.entity.position=new Vec3(goal.x+.5,goal.y,goal.z+.5)}
 await usePortal(g.bot,{kind:'use_portal',goal:{}},{...g.api,netherAllowed:true},{pollMs:5})
 assert.equal(target[1],64,'the walk aims at the portal\'s bottom level');assert.equal(Math.abs(target[0]-2)+Math.abs(target[2]),1,'beside the portal: '+target)
})

// A frame built on the ground lifts the portal's bottom cell one above the
// ground: the bot stands one lower beside it and jumps in, as a player does.
test('a portal one block above the ground is entered with a jump from beside it',async()=>{
 const f=fixture({'2,65,0':'nether_portal','2,66,0':'nether_portal','2,64,0':'obsidian'})
 f.bot.game.dimension='minecraft:overworld'
 f.bot.findBlock=()=>f.bot.blockAt(new Vec3(2,65,0))
 f.bot.pathfinder.goto=async g=>{f.log.push('walk '+[g.x,g.y,g.z]);f.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const step=f.bot.setControlState
 f.bot.setControlState=(k,v)=>{if(k==='jump'&&v)f.log.push('jump');step(k,v);if(k==='forward'&&v&&!f.crossed){f.crossed=true;setTimeout(()=>{f.bot.game.dimension='minecraft:the_nether'},20)}}
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5})
 assert.equal(r.receipt,'crossed');assert.ok(f.log.some(l=>/^walk .*,64,/.test(l)),f.log.join(' | '));assert.ok(f.log.includes('jump'))
})

// Run 73, 8 October: twice the bot stood "in" a portal for 15 seconds and was
// not carried across. A portal's working shape is a thin plane in the middle
// of its block; stopping the moment the feet reach the portal cell can leave
// the body short of it. The step in goes on to the middle of the cell.
test('stepping in goes on to the middle of the portal cell before waiting to cross',async()=>{
 const f=crossing('overworld',{carries:false})
 f.bot.pathfinder.goto=async g=>{f.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 // Held forward walks a tenth of a block per tick toward where the bot looks, as the client does.
 let forward=false
 f.bot.setControlState=(k,v)=>{if(k==='forward')forward=v}
 f.bot.clearControlStates=()=>{forward=false}
 const walk=setInterval(()=>{if(!forward||!f.bot.lookTarget)return;const p=f.bot.entity.position,t=f.bot.lookTarget,dx=t.x-p.x,dz=t.z-p.z,d=Math.hypot(dx,dz);if(d>0.01){const st=Math.min(0.1,d);f.bot.entity.position=new Vec3(p.x+dx/d*st,p.y,p.z+dz/d*st)}},2)
 let centred=false
 const poll=setInterval(()=>{const p=f.bot.entity.position;if(Math.floor(p.x)===2&&Math.abs(p.x-2.5)<0.2&&Math.abs(p.z-0.5)<0.2)centred=true},2)
 await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5,crossMs:60}).catch(()=>{})
 clearInterval(poll);clearInterval(walk)
 assert.ok(centred,'reached the middle of the portal cell')
})

// Run 80, 9 October: an escape stepped into the arrival portal, waited 15
// seconds and was not carried, then stepped out from the cell's edge. The
// centring is held for the whole wait, and the server counts only time in the
// middle: a bot pushed back to the edge walks to the middle again.
test('the wait to cross keeps the bot in the middle of the portal',async()=>{
 const f=crossing('overworld',{carries:false})
 f.bot.pathfinder.goto=async g=>{f.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 let forward=false,middleMs=0,pushed=false
 f.bot.setControlState=(k,v)=>{if(k==='forward')forward=v}
 f.bot.clearControlStates=()=>{forward=false}
 const walk=setInterval(()=>{
  const p=f.bot.entity.position,mid=Math.floor(p.x)===2&&Math.abs(p.x-2.5)<0.2&&Math.abs(p.z-0.5)<0.2
  if(mid&&!pushed&&f.log.includes('say In the portal; waiting to cross')){pushed=true;f.bot.entity.position=new Vec3(2.02,64,0.5);return}
  if(mid&&pushed&&(middleMs+=2)>=40&&!f.crossed){f.crossed=true;f.bot.game.dimension='minecraft:the_nether'}
  if(!forward||!f.bot.lookTarget)return;const t=f.bot.lookTarget,dx=t.x-p.x,dz=t.z-p.z,d=Math.hypot(dx,dz);if(d>0.01){const st=Math.min(0.1,d);f.bot.entity.position=new Vec3(p.x+dx/d*st,p.y,p.z+dz/d*st)}},2)
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5,crossMs:400}).finally(()=>clearInterval(walk))
 assert.equal(r.receipt,'crossed')
})
// Runs 81 and 82, measured by console: the dimension change finished only
// when the bot moved up or down (a jump, a climb, a step down). Level walking
// for 32 seconds, three entries included, never finished it. So the bot hops
// on arrival and before every step into a portal.
test('the bot hops before stepping into a portal, which lets the server finish its last crossing',async()=>{
 const f=crossing('the_nether',{carries:false})
 const step=f.bot.setControlState
 let entries=0,settled=false
 f.bot.setControlState=(k,v)=>{if(k==='jump'){f.bot.entity.onGround=!v;if(v)settled=true}
  const was=f.bot.entity.position.floored().x;step(k,v);const p=f.bot.entity.position.floored()
  if(k==='forward'&&v&&p.x===2&&was!==2){entries++;if(settled)setTimeout(()=>{f.bot.game.dimension='minecraft:overworld'},20)}}
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api},{pollMs:5,crossMs:80,pauseMs:10})
 assert.equal(r.receipt,'crossed');assert.equal(entries,1,'crossed on the first entry')
})
test('a portal that never carries the bot says whether it stood in the middle',async()=>{
 const f=crossing('overworld',{carries:false})
 f.bot.entity.position=new Vec3(1.5,64,0.5)
 f.bot.pathfinder.goto=async()=>{}
 // In at the edge and held there until it gives up and steps back out.
 const step=f.bot.setControlState
 f.bot.setControlState=(k,v)=>{if(k==='forward'&&v&&f.bot.entity.position.x<2){f.bot.entity.position=new Vec3(2.03,64,0.5);return}if(f.log.at(-1)?.includes('Stepping out'))step(k,v)}
 await assert.rejects(usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5,crossMs:60,pauseMs:5}),/never reached the middle of the portal/)
})

// Run 81, 9 October, measured by console: after a crossing the server finishes
// the dimension change late (once the bot moves), and until then and ten ticks
// after, standing in a portal only re-arms its cooldown. A portal that has not
// taken the bot in its usual time is stepped out of and entered again.
test('a portal that does not take the bot is stepped out of and entered again',async()=>{
 const f=crossing('overworld',{carries:false})
 const step=f.bot.setControlState
 let entries=0
 f.bot.setControlState=(k,v)=>{const was=f.bot.entity.position.floored().x;step(k,v);const p=f.bot.entity.position.floored();if(k==='forward'&&v&&p.x===2&&was!==2&&++entries===2)setTimeout(()=>{f.bot.game.dimension='minecraft:the_nether'},20)}
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5,crossMs:80,pauseMs:10})
 assert.equal(r.receipt,'crossed');assert.equal(entries,2)
 assert.ok(f.log.some(l=>/stepping out and in again/.test(l)),f.log.join(' | '))
 const g=crossing('overworld',{carries:false})
 await assert.rejects(usePortal(g.bot,{kind:'use_portal',goal:{}},{...g.api,netherAllowed:true},{pollMs:5,crossMs:40,pauseMs:5}),/did not carry me across in 3 tries/)
})

// Run 73: the escape fired from inside a hut and the walk could not leave it.
test('use_portal from inside a hut opens the wall facing the portal, then walks',async()=>{
 const walls={}
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(const y of [64,65])walls[`${-3+dx},${y},${0+dz}`]='cobblestone'
 walls['-3,66,0']='cobblestone'
 const f=crossing('overworld');for(const [k,v] of Object.entries(walls))f.world.set(k,v)
 f.bot.entity.position=new Vec3(-2.5,64,0.5)
 f.bot.dig=async b=>{f.log.push('dig '+key(b.position));f.world.set(key(b.position),'air')}
 f.bot.equip=async()=>{};f.bot.tool={async equipForBlock(){}}
 f.bot.pathfinder.goto=async g=>{const open=['-2,64,0','-2,65,0'].every(k=>f.world.get(k)==='air');if(!open)throw new Error('No path to the goal!');f.log.push('walk');f.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5})
 assert.equal(r.receipt,'crossed');assert.ok(f.log.includes('dig -2,64,0')&&f.log.includes('dig -2,65,0'),f.log.join(' | '))
})

// Run 74: a hostile cut the wall opening short after one of its two cells; the
// hut was no longer a closed cavity, so the next try did not open it and the
// pathfinder, finding no way out, resolved with an empty path.
test('a hut left half open is opened the rest of the way toward the portal',async()=>{
 const f=crossing('overworld')
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(const y of [64,65])f.world.set(`${-3+dx},${y},${0+dz}`,'cobblestone')
 f.world.set('-3,66,0','cobblestone');f.world.set('-2,64,0','air')
 f.bot.entity.position=new Vec3(-2.5,64,0.5)
 f.bot.dig=async b=>{f.log.push('dig '+key(b.position));f.world.set(key(b.position),'air')}
 f.bot.equip=async()=>{};f.bot.tool={async equipForBlock(){}}
 f.bot.pathfinder.goto=async g=>{if(f.world.get('-2,65,0')!=='air')return;f.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true},{pollMs:5})
 assert.equal(r.receipt,'crossed');assert.ok(f.log.includes('dig -2,65,0'),f.log.join(' | '))
})

// Lab run 100, 10 October: the bot walled in beside the arrival portal, dug out
// one side to work, and later, fleeing hoglins, found every cell beside the
// portal filled by its own cobblestone: "walled or flooded", and it fled deeper
// into the fortress instead and died. Its own blocks are its to take back.
function walledPortal({own}){
 const f=crossing('the_nether')
 for(const c of ['1,64,0','1,65,0','3,64,0','3,65,0','2,64,1','2,65,1','2,64,-1','2,65,-1'])f.world.set(c,'cobblestone')
 f.bot.ownBlocks={has:(p,name)=>own&&name==='cobblestone'}
 f.bot.dig=async b=>{f.log.push('dig '+key(b.position));f.world.set(key(b.position),'air')}
 return f
}
test('use_portal opens its own wall beside the portal, and only its own',async()=>{
 const f=walledPortal({own:true})
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api},{pollMs:5})
 assert.equal(r.receipt,'crossed',f.log.join(' | '))
 assert.deepEqual(f.log.filter(l=>l.startsWith('dig')),['dig 1,65,0','dig 1,64,0'],'the nearest side, head then feet')
 const g=walledPortal({own:false})
 await assert.rejects(usePortal(g.bot,{kind:'use_portal',goal:{}},{...g.api},{pollMs:5}),/walled or flooded/)
 assert.ok(!g.log.some(l=>l.startsWith('dig')),'never digs what someone else placed')
})
