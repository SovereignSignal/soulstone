import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {coveredMoves} from '../src/companion/covered-moves.js'
import {LocalPlanner,validateCovered} from '../src/companion/planner.js'
import {COVERED_MOVES,COVERED_CALLS,MODEL_DECISION_MS} from '../src/companion/continuity.js'
const registry=minecraftData('1.21.4')
// Play-world rehearsal, 16 October: walled in beside the arrival portal at the Nether hub, the wait
// held "for daylight and a clear area", which never comes in the Nether, until "Resume is
// required". Walled in on a trip, the bot digs a shaft and bores under cover instead.
// A hut at 0,64,0: placed cobblestone walls and roof, netherrack everywhere else.
const limits={budgetMs:400,decisionMs:80,pollMs:2,waitMs:5}
const kit=()=>[{name:'bow',count:1},{name:'arrow',count:40},{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0},{name:'iron_pickaxe',count:1,maxDurability:250,durabilityUsed:0},{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]
const wall=p=>(p.y===64||p.y===65)&&Math.abs(p.x)+Math.abs(p.z)===1||p.y===66&&p.x===0&&p.z===0
function fixture(choose,{act}={}){
 const cells=new Map(),commands=[],events=[],abort=new AbortController(),said=[],resumed=[],persisted=[]
 const name=p=>cells.get(`${p.x},${p.y},${p.z}`)??(p.x===0&&p.z===0&&(p.y===64||p.y===65)?'air':wall(p)?'cobblestone':'netherrack')
 const items=kit(),slots=[]
 const bot={registry,health:20,food:20,oxygenLevel:20,game:{gameMode:'survival',difficulty:'normal',dimension:'minecraft:the_nether'},time:{timeOfDay:6000},
  entity:{position:new Vec3(.5,64,.5),onGround:true,metadata:[0]},entities:{},players:{},inventory:{items:()=>items,slots},getEquipmentDestSlot:s=>({head:5,torso:6,legs:7,feet:8})[s],
  blockAt(p){const n=name(p);return {name:n,position:p.clone(),boundingBox:registry.blocksByName[n]?.boundingBox,getProperties:()=>({})}}}
 for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'golden_boots']])slots[i]={name:n}
 const runner={bot,ready:true,connectionId:'c',log:(type,data)=>events.push({type,...data})}
 const c={runner,epoch:1,projects:{},safety:{status:'burrowed',retreat:{shelterName:'hut',surface:{x:0,y:64,z:0}}},requestProgress:{id:'r',request:'blaze rods',status:'interrupted',completed:[],feedback:[]},recoveryHistory:[],
  planner:{covered:choose},persist(){persisted.push(structuredClone(c.safety?.covered??null))},say:text=>said.push(text),snapshot:()=>({inventory:{},position:bot.entity.position,health:bot.health}),dispatch:cmd=>commands.push(cmd),resume:async o=>{resumed.push(o)},
  async execute(cmd){commands.push(cmd);const result=await (act?.(cmd,bot,cells))??{receipt:cmd.action};runner.task={kind:cmd.action,status:'completed',result}}}
 // dig straight down: the column opens and the bot lands at its foot.
 if(!act)act=(cmd,b,m)=>{if(cmd.action==='dig'){for(let y=cmd.goal.y;y<64;y++)m.set(`0,${y},0`,'air');b.entity.position=new Vec3(.5,cmd.goal.y,.5);return {receipt:'dug',count:cmd.goal.count}}}
 return {bot,cells,c,commands,events,abort,said,resumed,persisted,run:(opts={})=>coveredMoves(c,1,abort.signal,bot,{eligible:true,...limits,...opts})}
}
const once=(...answers)=>{let i=0;return async()=>answers[Math.min(i++,answers.length-1)]}
const wait={action:'wait',target:null,count:0,expectation:'Hold'}
const acts=f=>f.commands.map(x=>x.action).filter(a=>a!=='stop')

test('the covered phase runs only walled in on a Nether trip with the request to hand back',async()=>{
 const cases=[['overworld',f=>{f.bot.game.dimension='minecraft:overworld'}],['no kit',f=>{f.bot.inventory.items().splice(0,1)}],['health 11',f=>{f.bot.health=11}],
  ['exit',f=>{f.c.safety.exit={receipt:'unhut'}}],['port',f=>{f.c.safety.port={side:'north'}}],['cap',f=>{f.c.requestProgress.coveredMoves=COVERED_MOVES}],['no request',f=>{f.c.requestProgress.status='cancelled'}]]
 for(const [name,set] of cases){
  let asked=0;const f=fixture(async()=>{asked++;return wait});set(f)
  const result=await f.run()
  assert.equal(result.status,'skipped',name);assert.equal(asked,0,name);assert.deepEqual(f.commands,[],name)
 }
})
test('dig straight down 3 from the hut is admitted: one dig, the record follows the bot, the hut record stays',async()=>{
 const f=fixture(once({action:'dig',target:{x:0,y:61,z:0},count:3,expectation:'A shaft to 61'},{action:'done',target:null,count:0,expectation:'Hand back'}))
 const result=await f.run()
 const digs=f.commands.filter(x=>x.action==='dig');assert.equal(digs.length,1,acts(f).join(' '))
 assert.deepEqual([digs[0].goal.x,digs[0].goal.y,digs[0].goal.z,digs[0].goal.count],[0,61,0,3])
 assert.equal(f.c.requestProgress.coveredMoves,1)
 assert.equal(result.status,'handed_back')
 const covered=f.c.requestProgress.safetyContinuations.at(-1);assert.equal(covered.shelter,'covered_route')
 assert.deepEqual(covered.covered.at,{x:0,y:61,z:0});assert.deepEqual(covered.covered.from,{x:0,y:64,z:0})
})
test('a dig the column check refuses is never dispatched, and the reason reaches the next decision',async()=>{
 const cases=[
  ['lateral air',f=>f.cells.set('1,62,0','air'),62,2,/beside the shaft/],
  ['lava under the foot',f=>f.cells.set('0,60,0','lava'),61,3,/under the shaft foot|lava/],
  ['magma beside',f=>f.cells.set('0,62,1','magma_block'),61,3,/magma_block/],
  ['count 5',()=>{},59,5,/1–4/],
  ['off the column',()=>{},61,3,/straight down/,{x:1,y:61,z:0}],
  ['above the feet',()=>{},66,2,/straight down/,{x:0,y:66,z:0}],
  ['gravel overhead in the column',f=>f.cells.set('0,62,0','gravel'),61,3,/gravel/],
  ['a placed block in the column',f=>f.cells.set('0,62,0','cobblestone'),61,3,/not natural/]]
 for(const [name,set,y,count,re,target] of cases){
  const seen=[]
  const f=fixture(async o=>{seen.push(o);return seen.length===1?{action:'dig',target:target??{x:0,y,z:0},count,expectation:'Shaft'}:wait});set(f)
  await f.run({budgetMs:60})
  assert.deepEqual(acts(f),[],name)
  assert.ok(seen.length>=2,name+': asked again');assert.ok(seen[1].recovery.recentAttempts.some(a=>a.status==='rejected'&&re.test(a.reason)),name+': '+JSON.stringify(seen[1].recovery.recentAttempts))
 }
})
test('bore through a hut wall that is neither rock nor the bot\'s own is refused as shaft first; from the shaft foot in rock it dispatches with the target and protected sites',async()=>{
 const bore={action:'bore',target:{x:20,y:61,z:0},count:6,expectation:'Toward the spawner'}
 const hut=fixture(once(bore,wait));await hut.run({budgetMs:60})
 assert.deepEqual(acts(hut),[]);assert.ok(hut.c.recoveryHistory.some(a=>a.status==='rejected'&&/shaft first/.test(a.reason)),JSON.stringify(hut.c.recoveryHistory))
 const shaft=fixture(once(bore,wait),{act:(cmd)=>({receipt:'bored',columns:cmd.goal.count,slit:null})})
 for(let y=61;y<64;y++)shaft.cells.set(`0,${y},0`,'air');shaft.bot.entity.position=new Vec3(.5,61,.5)
 shaft.c.projects={base:{name:'base',dimension:'the_nether',build:{origin:{x:100,y:64,z:100},design:[{x:0,y:0,z:0,block:'cobblestone'}]}}}
 await shaft.run({budgetMs:60})
 const sent=shaft.commands.find(x=>x.action==='bore');assert.ok(sent,acts(shaft).join(' '))
 assert.deepEqual([sent.goal.x,sent.goal.y,sent.goal.z,sent.goal.count],[20,61,0,6]);assert.ok(Array.isArray(sent.goal.protectedSites)&&sent.goal.protectedSites.length,JSON.stringify(sent.goal))
})
// Live, 16 October: the play-world seed's Nether arrival is on a fortress bridge of nether bricks, which
// the play-world rule never digs, so the shaft is refused there. From the hut a bore is admitted when its
// first column is the bot's own wall or rock, or open air over a solid floor that is not hot.
// Blaze death, 16 October 18:44Z: a covered bore from the hut on the bridge dug its own front wall into open
// floored air; the cavity joined the fortress ground and the shelter failed open. Under cover a bore goes
// through rock only: the first column is rock or the bot's own wall, and the column beyond it is full cubes.
test('a bore whose first column faces open air is refused before dispatch: the reason names the wall and reaches the next decision; its own wall into rock is admitted',async()=>{
 const bore={action:'bore',target:{x:20,y:64,z:0},count:6,expectation:'Along the bridge'}
 const bridge=f=>{for(const [k,v] of [['0,63,0','nether_bricks'],['1,63,0','nether_bricks']])f.cells.set(k,v)}
 const ownWall=f=>{f.bot.ownBlocks={has:()=>false,entry:p=>p.x===1&&p.z===0&&(p.y===64||p.y===65)?{name:'cobblestone'}:null}}
 const own=fixture(once(bore,wait),{act:()=>({receipt:'bored',columns:1,slit:null})});bridge(own);ownWall(own)
 await own.run({budgetMs:60});assert.ok(own.commands.some(x=>x.action==='bore'),'own wall into rock: '+JSON.stringify(own.c.recoveryHistory))
 const seen=[];const beyond=fixture(async o=>{seen.push(o);return seen.length===1?bore:wait});bridge(beyond);ownWall(beyond)
 // Open bridge beyond: no sides or roof over the column (a covered column there is the bot's own tunnel, below).
 for(let x=2;x<9;x++){for(const y of [64,65])for(const z of [-1,0,1])beyond.cells.set(`${x},${y},${z}`,'air');beyond.cells.set(`${x},66,0`,'air')}
 await beyond.run({budgetMs:60});assert.deepEqual(acts(beyond),[])
 assert.ok(seen[1]?.recovery.recentAttempts.some(a=>a.status==='rejected'&&/open ground beyond the wall at 1,64,0/.test(a.reason)),JSON.stringify(seen[1]?.recovery.recentAttempts))
 const air=fixture(once(bore,wait));bridge(air);air.cells.set('1,64,0','air');air.cells.set('1,65,0','air')
 await air.run({budgetMs:60});assert.deepEqual(acts(air),[],'an open first column');assert.ok(air.c.recoveryHistory.some(a=>a.status==='rejected'&&/rock only/.test(a.reason)),JSON.stringify(air.c.recoveryHistory))
 const lava=fixture(once(bore,wait));bridge(lava);ownWall(lava);lava.cells.set('1,64,1','lava')
 await lava.run({budgetMs:60});assert.deepEqual(acts(lava),[]);assert.ok(lava.c.recoveryHistory.some(a=>a.status==='rejected'&&/lava/.test(a.reason)))
})
// Live rehearsal, 16 October 22:13Z: walking its own covered tunnel east along the fortress bridge, a hoglin on
// the roof raised the alarm and the bot walled in inside the tunnel, plugging it one column ahead. The bore along
// its own sealed tunnel was refused as "open ground beyond the wall", done handed back into the same alarm, and
// the bot walled in again: it could never move on from cover. A column beyond the wall that is covered (air at
// feet and head; floor, both sides and roof full cubes; only the faces to the wall and to the next column open)
// is the bot's own tunnel, and a bore into it is admitted; a partly open column, or one a mob stands in, is not.
const ownTunnel=f=>{
 for(const [k,v] of [['0,63,0','nether_bricks'],['1,63,0','nether_bricks']])f.cells.set(k,v)
 f.bot.ownBlocks={has:()=>false,entry:p=>p.x===1&&p.z===0&&(p.y===64||p.y===65)?{name:'cobblestone'}:null}
 for(let x=2;x<9;x++){
  for(const y of [64,65]){f.cells.set(`${x},${y},0`,'air');for(const z of [-1,1]){f.cells.set(`${x},${y},${z}`,'cobblestone');f.cells.set(`${x},${y},${2*z}`,'air')}}
  f.cells.set(`${x},63,0`,'nether_bricks');f.cells.set(`${x},66,0`,'cobblestone');f.cells.set(`${x},67,0`,'air')
 }
}
// The tunnel runs x 2 to 8 and ends at rock at x 9; a count of 8 walks to x 8 and the next column is that rock.
const alongTunnel={action:'bore',target:{x:12,y:64,z:0},count:8,expectation:'On along my own tunnel'}
test('walled in inside its own covered tunnel, a covered bore on along the tunnel is admitted and dispatched',async()=>{
 const f=fixture(once(alongTunnel,wait),{act:()=>({receipt:'bored',columns:6,slit:null})});ownTunnel(f)
 await f.run({budgetMs:60})
 const sent=f.commands.find(x=>x.action==='bore');assert.ok(sent,JSON.stringify(f.c.recoveryHistory))
 assert.deepEqual([sent.goal.x,sent.goal.y,sent.goal.z,sent.goal.count],[12,64,0,8])
})
test('a tunnel column beyond the wall missing one skin cell is still open ground, refused as before',async()=>{
 const f=fixture(once(alongTunnel,wait));ownTunnel(f);f.cells.set('2,65,1','air')
 await f.run({budgetMs:60});assert.deepEqual(acts(f),[])
 assert.ok(f.c.recoveryHistory.some(a=>a.status==='rejected'&&/open ground beyond the wall at 1,64,0.*rock only/.test(a.reason)),JSON.stringify(f.c.recoveryHistory))
})
test('a mob standing in the covered tunnel column beyond the wall refuses the bore, and the reason names it',async()=>{
 const f=fixture(once(alongTunnel,wait));ownTunnel(f)
 f.bot.entities={7:{id:7,type:'mob',name:'hoglin',height:1.4,position:new Vec3(2.5,64,.5),velocity:new Vec3(0,0,0)}}
 await f.run({budgetMs:60});assert.deepEqual(acts(f),[])
 assert.ok(f.c.recoveryHistory.some(a=>a.status==='rejected'&&/hoglin in 2,64,0/.test(a.reason)),JSON.stringify(f.c.recoveryHistory))
})
// Review of the 22:13Z fix: only the first column beyond the wall was read, so a tunnel whose end plug was gone,
// open bridge two columns on, or a mob there, passed the gate; bore then dug the hut wall and the cavity joined the
// open ground (the 18:44Z blaze-death shape). Every column the bore walks is read, up to rock or a closed end.
test('a covered bore is refused when the tunnel opens further on, runs open past the bore\'s end, or holds a mob, and the reason names the cell',async()=>{
 const open=fixture(once(alongTunnel,wait));ownTunnel(open)
 for(let x=3;x<9;x++){for(const y of [64,65])for(const z of [-1,1])open.cells.set(`${x},${y},${z}`,'air');open.cells.set(`${x},66,0`,'air')}
 await open.run({budgetMs:60});assert.deepEqual(acts(open),[],'end plug gone')
 assert.ok(open.c.recoveryHistory.some(a=>a.status==='rejected'&&/open ground beyond the wall at 1,64,0 \(air at 3,6[45],-?1\)/.test(a.reason)),JSON.stringify(open.c.recoveryHistory))
 const short=fixture(once({...alongTunnel,count:4},wait));ownTunnel(short)
 await short.run({budgetMs:60});assert.deepEqual(acts(short),[],'a bore that ends inside the open tunnel')
 assert.ok(short.c.recoveryHistory.some(a=>a.status==='rejected'&&/5,6[45],0/.test(a.reason)),JSON.stringify(short.c.recoveryHistory))
 const mob=fixture(once(alongTunnel,wait));ownTunnel(mob)
 mob.bot.entities={7:{id:7,type:'mob',name:'blaze',height:1.8,width:.6,position:new Vec3(3.5,64,.5),velocity:new Vec3(0,0,0)}}
 await mob.run({budgetMs:60});assert.deepEqual(acts(mob),[],'a mob two columns on')
 assert.ok(mob.c.recoveryHistory.some(a=>a.status==='rejected'&&/blaze in 3,6[45],0/.test(a.reason)),JSON.stringify(mob.c.recoveryHistory))
 // A 0.9-wide hoglin whose feet are floored outside the column still straddles into it.
 const straddle=fixture(once(alongTunnel,wait));ownTunnel(straddle)
 straddle.bot.entities={8:{id:8,type:'mob',name:'hoglin',height:1.4,width:.9,position:new Vec3(2.5,64,1.3),velocity:new Vec3(0,0,0)}}
 await straddle.run({budgetMs:60});assert.deepEqual(acts(straddle),[],'a straddling hoglin')
 assert.ok(straddle.c.recoveryHistory.some(a=>a.status==='rejected'&&/hoglin in 2,6[45],0/.test(a.reason)),JSON.stringify(straddle.c.recoveryHistory))
})
test('a covered tunnel closed at its end by the bot\'s cobblestone plug or by rock admits the bore',async()=>{
 const plug=fixture(once({...alongTunnel,count:6},wait),{act:()=>({receipt:'bored',columns:6,slit:null})});ownTunnel(plug)
 for(const y of [64,65])plug.cells.set(`7,${y},0`,'cobblestone')
 await plug.run({budgetMs:60});assert.ok(plug.commands.some(x=>x.action==='bore'),JSON.stringify(plug.c.recoveryHistory))
 const rock=fixture(once({...alongTunnel,count:12},wait),{act:()=>({receipt:'bored',columns:8,slit:null})});ownTunnel(rock)
 await rock.run({budgetMs:60});assert.ok(rock.commands.some(x=>x.action==='bore'),'rock inside the walk: '+JSON.stringify(rock.c.recoveryHistory))
})
test('the covered prompt does not offer bores across open air',async()=>{
 const p=new LocalPlanner();let prompt='';p.structured=async m=>{prompt=m[0].content;return wait}
 await p.covered({},new AbortController().signal);assert.ok(!/open air/.test(prompt.split('walled in on a Nether trip')[1]),prompt.slice(-600))
})
// A breach the bot's own move makes is a refused move: stop, wall in again where it stands, and tell the model.
function breaching(f,{times=1}={}){
 let n=0
 return (cmd,bot,m)=>{
  if(cmd.action==='bore'&&n++<times){for(let x=1;x<300;x++)m.set(`${x},61,0`,'air');return new Promise(r=>setTimeout(()=>r({receipt:'bored',columns:1}),40))}
  if(cmd.action==='hut'){for(let x=1;x<300;x++)m.delete(`${x},61,0`);return {receipt:'walled_in',surface:{x:0,y:61,z:0}}}
 }
}
const atShaftFoot=f=>{for(let y=61;y<64;y++)f.cells.set(`0,${y},0`,'air');f.bot.entity.position=new Vec3(.5,61,.5)}
test('a cavity breach during a move stops it, walls in again where the bot stands, and counts as a refusal; the hut record and the wait survive',async()=>{
 const seen=[],bore={action:'bore',target:{x:20,y:61,z:0},count:6,expectation:'Toward the spawner'}
 const f=fixture(async o=>{seen.push(o);return seen.length===1?bore:wait});f.c.execute=undefined
 const act=breaching(f);Object.assign(f,{});f.c.execute=async function(cmd){f.commands.push(cmd);const result=await act(cmd,f.bot,f.cells)??{receipt:cmd.action};f.c.runner.task={kind:cmd.action,status:'completed',result}}
 atShaftFoot(f)
 const result=await f.run({budgetMs:150})
 assert.equal(result.status,'held');const order=acts(f);assert.deepEqual(order.slice(0,2),['bore','hut'],order.join(' '))
 assert.ok(f.c.recoveryHistory.some(a=>a.status==='rejected'&&/opened the cavity/.test(a.reason)),JSON.stringify(f.c.recoveryHistory))
 assert.ok(seen[1]?.recovery.recentAttempts.some(a=>/opened the cavity/.test(a.reason||'')),'the next decision reads it')
 assert.ok(f.c.safety&&f.c.safety.status==='burrowed')
})
test('two breaches hold the phase with the hut shut; the watch then judges the hut',async()=>{
 const f=fixture(async()=>({action:'bore',target:{x:20,y:61,z:0},count:6,expectation:'Again'}))
 const act=breaching(f,{times:2});f.c.execute=async function(cmd){f.commands.push(cmd);const result=await act(cmd,f.bot,f.cells)??{receipt:cmd.action};f.c.runner.task={kind:cmd.action,status:'completed',result}}
 atShaftFoot(f)
 const result=await f.run();assert.equal(result.status,'held');assert.match(result.reason,/opened the cavity/)
 assert.deepEqual(acts(f),['bore','hut','bore','hut'])
 assert.equal(inspectEmergencyShelter(f.bot,{limit:256}).verified,true)
})
test('a bore receipt with a slit hands the request back: safety cleared, one automatic resume, a covered_route continuation, never unhut',async()=>{
 const f=fixture(once({action:'bore',target:{x:20,y:61,z:0},count:6,expectation:'To the bay'}),{act:()=>({receipt:'bored',columns:5,slit:[{x:6,y:62,z:0}]})})
 for(let y=61;y<64;y++)f.cells.set(`0,${y},0`,'air');f.bot.entity.position=new Vec3(.5,61,.5)
 const result=await f.run()
 assert.equal(result.status,'handed_back');assert.equal(f.c.safety,null);assert.equal(f.c.phase,'blocked')
 assert.equal(f.resumed.length,1);assert.equal(f.resumed[0].automatic,true)
 assert.equal(f.c.requestProgress.safetyContinuations.at(-1).shelter,'covered_route')
 assert.ok(!f.commands.some(x=>['unhut','unburrow'].includes(x.action)),acts(f).join(' '))
})
test('done hands back the same way; wait re-asks only when the decision state changes',async()=>{
 const done=fixture(once({action:'done',target:null,count:0,expectation:'The planner bores'}));const result=await done.run()
 assert.equal(result.status,'handed_back');assert.equal(done.resumed.length,1);assert.equal(done.c.safety,null);assert.deepEqual(acts(done),[])
 let calls=0;const held=fixture(async()=>{calls++;return wait})
 assert.equal((await held.run({budgetMs:60})).status,'held');assert.equal(calls,1);assert.deepEqual(acts(held),[])
 let again=0;const changed=fixture(async()=>{again++;return wait})
 const running=changed.run({budgetMs:150});setTimeout(()=>{changed.bot.food=15},20)
 await running;assert.equal(again,2)
})
for(const change of ['breach','damage','stop','request','connection'])test(`${change} while the decision is pending: nothing is dispatched`,async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,40));return {action:'dig',target:{x:0,y:62,z:0},count:2,expectation:'Shaft'}})
 const run=f.run();setTimeout(()=>{if(change==='breach')for(let x=1;x<300;x++)f.cells.set(`${x},64,0`,'air');if(change==='damage')f.bot.health=19;if(change==='stop'){f.c.epoch++;f.abort.abort()}if(change==='request')f.c.requestProgress={id:'other'};if(change==='connection')f.c.runner.connectionId='other'},5)
 if(change==='breach')await assert.rejects(run,/open or exceeds/)
 else if(change==='damage')assert.equal((await run).status,'held')
 else assert.equal((await run).status,'cancelled')
 await new Promise(r=>setTimeout(r,60));assert.deepEqual(acts(f),[],change)
})
test('a move stops when health falls during it, and the phase hands the hut back to the watch',async()=>{
 const f=fixture(once({action:'dig',target:{x:0,y:62,z:0},count:2,expectation:'Shaft'}),{act:async(cmd,bot)=>{bot.health=17;await new Promise(r=>setTimeout(r,30));return {receipt:'dug'}}})
 const result=await f.run();assert.equal(result.status,'held');assert.match(result.reason,/Health fell/);assert.ok(f.commands.some(x=>x.action==='stop'),acts(f).join(' '))
})
// Review of 7d69c86, 16 October: a burn tick while the model thought failed the shelter, the retry
// shot from the open, the loss this branch prevents. A drop while alight or just after is a burn, as the wait judges it.
test('a burn tick while the decision is pending does not fail the shelter, and no move starts while alight',async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,40));return {action:'dig',target:{x:0,y:62,z:0},count:2,expectation:'Shaft'}})
 const run=f.run({budgetMs:120});setTimeout(()=>{f.bot.entity.metadata[0]=1;f.bot.health=18},5)
 const result=await run;assert.equal(result.status,'held');assert.deepEqual(acts(f),[])
})
test('the covered record is saved before a move runs, so a restart mid-bore watches the whole route',async()=>{
 let seen=null
 const f=fixture(once({action:'dig',target:{x:0,y:61,z:0},count:3,expectation:'Shaft'},wait),{act:(cmd,b,m)=>{seen=f.persisted.at(-1);for(let y=61;y<64;y++)m.set(`0,${y},0`,'air');b.entity.position=new Vec3(.5,61,.5);return {receipt:'dug'}}})
 await f.run({budgetMs:60})
 assert.ok(seen,'persisted before the dig ran');assert.deepEqual(seen.from,{x:0,y:64,z:0})
})
test('model calls are capped per request; an explicit Resume resets the moves and calls',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return wait});f.c.requestProgress.coveredCalls=COVERED_CALLS
 assert.equal((await f.run()).status,'skipped');assert.equal(calls,0)
 const g=fixture(async()=>wait);const running=g.run({budgetMs:300,waitMs:0});let flip=0;const t=setInterval(()=>{g.bot.food=15+(flip++%2)},3)
 await running;clearInterval(t);assert.ok(g.c.requestProgress.coveredCalls<=COVERED_CALLS,String(g.c.requestProgress.coveredCalls))
 const h=fixture(async()=>wait);Object.assign(h.c.requestProgress,{coveredMoves:COVERED_MOVES,coveredCalls:COVERED_CALLS,standSkips:2})
 Object.assign(h.c,{abort:{},runner:{...h.c.runner,respawnPending:false},snapshot:()=>({dead:false}),emit(){}})
 await Teammate.prototype.resume.call(h.c,{})
 assert.equal(h.c.requestProgress.coveredMoves,undefined);assert.equal(h.c.requestProgress.coveredCalls,undefined);assert.equal(h.c.requestProgress.standSkips,undefined)
})
test('the hand-back line is said once a minute, not every cycle',async()=>{
 const f=fixture(once({action:'done',target:null,count:0,expectation:'Hand back'}))
 const safety=structuredClone(f.c.safety);await f.run()
 f.c.safety=structuredClone(safety);f.c.requestProgress.status='interrupted';await f.run()
 assert.equal(f.resumed.length,2);assert.equal(f.said.filter(t=>/Carrying on/.test(t)).length,1,f.said.join(' | '))
})
test('an action outside the closed schema or a malformed target is refused before anything is dispatched',()=>{
 for(const bad of [{action:'unhut',target:null,count:0,expectation:'Out'},{action:'dig',target:{x:0,y:61},count:3,expectation:'Shaft'},{action:'dig',target:{x:0,y:61,z:0},count:3,expectation:'Shaft',extra:1},{action:'wait',target:null,count:0,expectation:''},{action:'bore',target:{x:.5,y:61,z:0},count:3,expectation:'Bore'}])
  assert.throws(()=>validateCovered(bad),/Invalid covered decision/,JSON.stringify(bad))
 for(const ok of [wait,{action:'done',target:null,count:0,expectation:'Done'},{action:'dig',target:{x:0,y:61,z:0},count:3,expectation:'Shaft'},{action:'bore',target:{x:9,y:61,z:2},count:9,expectation:'Bore'}])
  assert.equal(validateCovered(ok).action,ok.action)
})
test('the covered provider returns the validated decision and respects late cancellation',async()=>{
 const p=new LocalPlanner(),abort=new AbortController()
 p.structured=async()=>({action:'dig',target:{x:0,y:61,z:0},count:3,expectation:'Shaft'});assert.equal((await p.covered({},abort.signal)).count,3)
 p.structured=async()=>({action:'leave',target:null,count:0,expectation:'Out'});await assert.rejects(p.covered({},abort.signal),/Invalid covered decision/)
 p.structured=async()=>{abort.abort();return wait};await assert.rejects(p.covered({},abort.signal),/Cancelled/)
})

import {Teammate} from '../src/companion/controller.js'
import {inspectEmergencyShelter} from '../src/shelter-occupants.js'
const inWait=(f,extra={})=>Object.assign(f.c,{coveredMoves:true,coveredLimits:limits,shelterPlanning:false,burrowWait:{quietMs:50,limitMs:1500,watches:1},emit(){},killSites:[],...extra})
test('the shelter wait runs the covered phase first and returns once it hands the request back',async()=>{
 const f=fixture(once({action:'done',target:null,count:0,expectation:'The planner bores'}));inWait(f)
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.equal(f.resumed.length,1);assert.equal(f.resumed[0].automatic,true);assert.equal(f.c.safety,null);assert.deepEqual(acts(f),[])
})
// A shaft from the hut to y 61 and a bore tunnel 19 columns east of its foot: 43 closed cells.
function tunnelled(f){for(let y=61;y<64;y++)f.cells.set(`0,${y},0`,'air');for(let x=1;x<20;x++)for(const y of [61,62])f.cells.set(`${x},${y},0`,'air');f.bot.entity.position=new Vec3(.5,61,.5)}
test('a long covered route is still a closed cavity at the covered limit, and still open at the default',()=>{
 const f=fixture(async()=>wait);tunnelled(f)
 assert.equal(inspectEmergencyShelter(f.bot,{limit:256}).cells,43)
 assert.throws(()=>inspectEmergencyShelter(f.bot),/open or exceeds/)
 f.cells.set('10,61,0','lava');assert.throws(()=>inspectEmergencyShelter(f.bot,{limit:256}),/liquid/)
 f.cells.set('10,61,0','fire');assert.throws(()=>inspectEmergencyShelter(f.bot,{limit:256}),/fire/)
})
test('after covered moves the wait watches the whole route, and a cleared watch hands back without unhut',async()=>{
 const f=fixture(async()=>wait);tunnelled(f);inWait(f,{coveredMoves:false})
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:61,z:0},moves:[{action:'dig',target:{x:0,y:61,z:0},count:3,receipt:{receipt:'dug'}}]}
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.equal(f.c.safety,null,JSON.stringify(f.said));assert.equal(f.resumed.length,1,f.said.join(' | '))
 assert.ok(!f.commands.some(x=>['unhut','unburrow','hut'].includes(x.action)),acts(f).join(' '))
 assert.equal(f.c.requestProgress.safetyContinuations.at(-1).shelter,'covered_route')
})
test('restarted with a covered route saved, the wait is re-armed in it',async()=>{
 const {mkdtempSync,writeFileSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{EventEmitter}=await import('node:events')
 const path=join(mkdtempSync(join(tmpdir(),'mc-covered-')),'state.json')
 const covered={from:{x:0,y:64,z:0},at:{x:0,y:61,z:0},moves:[]}
 writeFileSync(path,JSON.stringify({profile:'covered-test',places:{},messages:[],projects:{},requestProgress:{id:'r',request:'blaze rods',status:'interrupted',feedback:[]},safety:{status:'burrowed',reason:'threat',retries:0,retreat:{shelterName:'hut',surface:{x:0,y:64,z:0}},covered}}))
 const r=new EventEmitter();Object.assign(r,{ready:false,profile:'covered-test',owner:'Player',commands:[],command(c){this.commands.push(c)},position:()=>null})
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},path)
 assert.equal(c.restoreBurrow,true);assert.deepEqual(c.safety.covered,covered)
})
// Review of 1fe8e32, 16 October: the wait took its health line before the covered phase, so a burn in
// the phase whose fire was out by the time it held read as a breach, and the retry shot from the open.
test('health lower after a held covered phase with the fire out does not fail the shelter',async()=>{
 const f=fixture(async()=>{if(f.bot.health===20){f.bot.entity.metadata[0]=1;f.bot.health=18;setTimeout(()=>{f.bot.entity.metadata[0]=0},10)}await new Promise(r=>setTimeout(r,20));return wait})
 inWait(f,{coveredLimits:{...limits,budgetMs:120}})
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.notEqual(f.c.safety?.status,'failed',f.said.join(' | '));assert.ok(!f.said.some(t=>/Health fell/.test(t)),f.said.join(' | '))
})
// Live, 18:43Z, 16 October: walled in on its own covered route twelve blocks from the spawner, blazes at
// 6.7 to 8.3 blocks; every covered bore was cancelled by the alarm, and with safety.covered set the port
// branch was skipped, so the bot never shot back. A shooter in sight through a port the hut would open
// is answered from the port; the covered phase holds without a model call while one is there.
function shooterEast(f){
 f.cells.set('1,65,0','netherrack');f.bot.world={raycast:()=>null,getColumn:()=>({})}
 for(let x=2;x<9;x++)for(const y of [64,65,66])f.cells.set(`${x},${y},0`,'air')
 f.bot.entities={7:{id:7,uuid:'10000000-0000-0000-0000-000000000007',type:'mob',name:'blaze',height:1.8,position:new Vec3(6.5,64,.5),velocity:new Vec3(0,0,0)}}
}
// Review of the R9 fix: on a blaze rod request at a valid stand cell (this one is) the planner is asked and offered the stand
// (below); the port's hold is for every other request and cell, so this request is not for rods.
test('the covered phase holds without a model call while a shooter is in sight through a port',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {action:'bore',target:{x:20,y:64,z:0},count:6,expectation:'Bore'}});shooterEast(f);f.c.requestProgress.request='ender pearls'
 const result=await f.run();assert.equal(result.status,'held');assert.match(result.reason,/blaze/);assert.equal(calls,0);assert.deepEqual(acts(f),[])
})
// Run 8, 17 October 02:30:40Z: at the ten-minute hold bound the covered planner was due (hold_bounded, next
// covered_planner), but atPort saw a blaze the watch would not shoot, the phase held with no model call, and
// the trip ended with nothing gained. Under the bound the port shortcut does not answer for the planner.
test('under the hold bound a shooter in sight through a port does not hold the phase: the planner is asked',async()=>{
 const seen=[];const f=fixture(async o=>{seen.push(o);return {action:'done',target:null,count:0,expectation:'Home under cover'}});shooterEast(f)
 const {atPort}=await import('../src/companion/covered-moves.js');assert.equal(atPort(f.bot)?.name,'blaze','the port sees the blaze')
 const result=await f.run({holdBounded:{minutes:10}});assert.equal(result.status,'handed_back',JSON.stringify(result))
 assert.equal(seen.length,1);assert.deepEqual(seen[0].holdBounded,{minutes:10});assert.equal(f.resumed.length,1)
 // Its decision budget spent, the bound still asks no model: the gate holds.
 const g=fixture(async o=>{seen.push(o);return wait});shooterEast(g);g.c.requestProgress.coveredCalls=COVERED_CALLS
 const spent=await g.run({holdBounded:{minutes:10}});assert.equal(spent.status,'skipped');assert.match(spent.reason,/covered decisions asked/);assert.equal(seen.length,1)
})
// Live rehearsal, 20 October: pinned at the spawner hut for the best part of an hour, the port kept
// sight of a blaze it could not actually shoot (the watch journalled the port held for no line), the
// shortcut held the phase without asking, and handbacks died to the alarm within seconds. A port the
// watch has just found no shot through is not answering anything: the planner is asked.
test('a port the watch just held for no shot does not hold the covered phase: the planner is asked',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {action:'done',target:null,count:0,expectation:'Home'}});shooterEast(f);f.c.requestProgress.request='ender pearls'
 f.c.portHeldKey='blaze:cobblestone:0';f.c.portHeldLogAt=Date.now()
 const result=await f.run();assert.equal(result.status,'handed_back',JSON.stringify(result));assert.equal(calls,1)
})
// Live, same pin: 'done' handed the request back, the alarm cancelled the first goto inside seconds,
// and the covered phase was asked again at the same cell, round after round. Two handbacks at one
// cell with no covered move between and a third 'done' is refused, so the model must move under cover.
test('a third done at the same cell after two handbacks there is refused; the model must move',async()=>{
 const answers=[{action:'done',target:null,count:0,expectation:'Planner walks'},{action:'dig',target:{x:0,y:61,z:0},count:3,expectation:'A shaft to 61'},{action:'done',target:null,count:0,expectation:'Hand back'}]
 let calls=0;const f=fixture(async()=>answers[Math.min(calls++,answers.length-1)]);f.c.requestProgress.request='ender pearls'
 f.c.requestProgress.coveredHandback={at:{x:0,y:64,z:0},count:2}
 const result=await f.run();assert.equal(result.status,'handed_back',JSON.stringify(result))
 assert.equal(f.commands.filter(x=>x.action==='dig').length,1,acts(f).join(' '));assert.equal(calls,3)
 assert.ok(f.c.recoveryHistory.some(r=>/handed back/.test(r.reason||'')),JSON.stringify(f.c.recoveryHistory))
})
test('with a covered route, a blaze in sight through the side port is shot from the port, and the hut closes it after',async()=>{
 const f=fixture(async()=>wait,{act:(cmd,bot)=>{if(cmd.action==='shoot'){delete bot.entities[7];return {receipt:'killed',shots:2,item:'blaze',at:{x:6.5,y:64,z:.5}}}if(cmd.action==='unhut')return {receipt:'unwalled',port:true,side:{dx:1,dz:0}};if(cmd.action==='hut')return {receipt:'walled_in',surface:{x:0,y:64,z:0}}}})
 shooterEast(f);inWait(f,{coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:1}})
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 const order=acts(f);assert.deepEqual(order.slice(0,3),['unhut','shoot','hut'],order.join(' ')+' :: '+f.said.join(' | '))
 assert.equal(f.commands.find(x=>x.action==='unhut').goal.shooter,'blaze')
})
// Review of 875042a, 16 October: a bore that used its plugs could open the port and then fail to close it with
// blazes near. The port opens only with blocks to close it again and one to spare.
test('when the port stays shut for want of blocks, the watch goes on and hands back once the area clears',async()=>{
 const f=fixture(async()=>wait,{act:()=>({receipt:'unwalled'})})
 shooterEast(f);inWait(f,{coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:1}})
 for(let x=-3;x<0;x++)for(const y of [64,65])f.cells.set(`${x},${y},0`,'air')
 f.bot.inventory.items().find(i=>i.name==='cobblestone').count=2
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 const say=f.c.say;f.c.say=t=>{say(t);if(/not enough blocks/i.test(t))f.bot.entities={}}
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.ok(!f.commands.some(x=>['unhut','shoot'].includes(x.action)),acts(f).join(' '))
 assert.equal(f.resumed.length,1,f.said.join(' | '));assert.equal(f.c.safety,null)
})
test('on a covered route with too few blocks to close the port again, the port stays shut and the reason is said once while it holds',async()=>{
 const f=fixture(async()=>wait,{act:()=>({receipt:'unwalled'})})
 shooterEast(f);inWait(f,{coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:1}})
 // The bot stands in its route: the west side is the tunnel behind it.
 for(let x=-3;x<0;x++)for(const y of [64,65])f.cells.set(`${x},${y},0`,'air')
 f.bot.inventory.items().find(i=>i.name==='cobblestone').count=2
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 // The blaze stays through two held ports, then leaves.
 const log=f.c.runner.log;f.c.runner.log=(t,d)=>{log(t,d);if(t==='port_held'&&f.events.filter(e=>e.type==='port_held').length>=2)f.bot.entities={}}
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.ok(!f.commands.some(x=>['unhut','shoot'].includes(x.action)),acts(f).join(' '))
 assert.ok(f.events.filter(e=>e.type==='port_held').length>=2)
 assert.equal(f.said.filter(t=>/not enough blocks to close the port again/i.test(t)).length,1,f.said.join(' | '))
 assert.equal(f.resumed.length,1)
})
test('with the port held shut for want of blocks, the watch still notices a breach',async()=>{
 const f=fixture(async()=>wait,{act:()=>({receipt:'unwalled'})})
 shooterEast(f);inWait(f,{coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:1}})
 for(let x=-3;x<0;x++)for(const y of [64,65])f.cells.set(`${x},${y},0`,'air')
 f.bot.inventory.items().find(i=>i.name==='cobblestone').count=2
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 const log=f.c.runner.log;f.c.runner.log=(t,d)=>{log(t,d);if(t==='port_held')for(let z=1;z<300;z++)f.cells.set(`-3,64,${z}`,'air')}
 const safety=f.c.safety
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.equal(safety.status,'failed');assert.match(safety.error,/open or exceeds/)
})

// Live rehearsal, 16 October 22:21Z to 22:38Z: walled in in its own tunnel beside the spawner, the watch opened a port
// toward a blaze 2.1 blocks off beside the wall, diagonal to the port, again and again; the line from the eye left the
// port cell through its side into rock, every shot failed "No clear shot", and each cycle cost a dig and a cobblestone.
// Here the room east of the hut is open, the port cell 1,65,0 is rock as in shooterEast, the rock at 1,65,1 stands beside
// it, and the raycast is real.
function blazeBeside(f,at=[2.5,64,1.5]){
 f.cells.set('1,65,0','netherrack')
 for(let x=2;x<9;x++)for(const y of [64,65,66])for(let z=-2;z<=3;z++)f.cells.set(`${x},${y},${z}`,'air')
 f.bot.world={getColumn:()=>({}),raycast:(from,dir,range)=>{for(let d=0;d<=range;d+=.01){const c=from.plus(dir.scaled(d)).floored(),b=f.bot.blockAt(c);if(b.boundingBox==='block')return {name:b.name,position:c}}return null}}
 f.bot.entities={7:{id:7,uuid:'10000000-0000-0000-0000-000000000007',type:'mob',name:'blaze',height:1.8,position:new Vec3(...at),velocity:new Vec3(0,0,0)}}
}
const portWait={coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:1}}
// A port that does open is opened twice at most here: then the blaze goes, so a loop like the live one ends.
const portAct=(cmd,bot)=>{if(cmd.action!=='unhut')return;portAct.opened=(portAct.opened||0)+1;if(portAct.opened>=2)bot.entities={};return {receipt:'unwalled',port:true,side:{dx:1,dz:0}}}
test('the watch never opens a port toward a shooter no port line reaches',async()=>{
 const f=fixture(async()=>wait,{act:portAct});portAct.opened=0;blazeBeside(f);inWait(f,portWait)
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
  assert.ok(!f.commands.some(x=>['unhut','shoot','hut'].includes(x.action)),acts(f).join(' ')+' :: '+f.said.join(' | '))
 assert.equal(f.cells.get('1,65,0'),'netherrack','the hut wall stands')
 // Judged in line, then gone beside the wall before the port opens: the controller asks the line again and holds.
 const g=fixture(async()=>wait,{act:portAct});portAct.opened=0;blazeBeside(g,[6.5,64.2,.5]);inWait(g,portWait)
 g.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 const persist=g.c.persist;let moved=false
 g.c.persist=function(){persist.call(this);if(!moved&&g.c.safety?.continuation?.status==='cleared'&&g.c.safety.continuation.observation?.confront){moved=true;g.bot.entities[7].position=new Vec3(2.5,64,1.5)}}
 await Teammate.prototype.waitInBurrow.call(g.c,1,g.abort.signal,g.bot,true)
 assert.ok(moved,'the watch judged the blaze in line first');assert.ok(!g.commands.some(x=>['unhut','shoot','hut'].includes(x.action)),acts(g).join(' '))
 const held=g.events.filter(e=>e.type==='port_held');assert.equal(held.length,1,JSON.stringify(g.events));assert.equal(held[0].reason,'no port line');assert.equal(held[0].shooter,'blaze')
 assert.equal(g.said.filter(t=>/No clear shot at the blaze/.test(t)).length,1,g.said.join(' | '))
})
test('the covered phase holds for a blaze with a port line, and not for one beside the wall without one',async()=>{
 const {atPort}=await import('../src/companion/covered-moves.js')
 const f=fixture(async()=>wait);blazeBeside(f,[6.5,64.2,.5]);assert.equal(atPort(f.bot)?.name,'blaze')
 const g=fixture(async()=>wait);blazeBeside(g);assert.equal(atPort(g.bot),null)
})

// Live rehearsal, 16 October 22:28Z to 23:09Z: walled in at its slit beside the spawner, blazes always in view, the wait
// never cleared and the port cycled for forty minutes at health 20; the planner was never asked again. On a trip a hold
// that gains nothing for the bound asks the covered planner, told so, and with its budget spent the trip ends, hut shut.
const bounded={coveredMoves:true,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:2,holdBoundMs:300}}
test('a trip hold that gains nothing for the bound asks the covered planner, told so, and never idles on',async()=>{
 const seen=[];const f=fixture(async o=>{seen.push(o);return o.holdBounded?{action:'done',target:null,count:0,expectation:'Home under cover'}:wait});blazeBeside(f);inWait(f,bounded)
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 const held=f.events.filter(e=>e.type==='hold_bounded');assert.equal(held.length,1,f.said.join(' | '));assert.equal(held[0].next,'covered_planner')
 assert.deepEqual(seen.at(-1).holdBounded,{minutes:1},'the planner is told the hold gained nothing');assert.equal(f.resumed.length,1,f.said.join(' | '))
 assert.ok(!f.commands.some(x=>['unhut','shoot'].includes(x.action)),acts(f).join(' '))
 assert.ok(f.said.includes('Nothing has changed here for 1 minute. Choosing what to do next, under cover.'),f.said.join(' | '))
})
test('with the covered planner spent, a trip hold that gains nothing ends the trip with the hut shut',async()=>{
 const f=fixture(async()=>wait);blazeBeside(f);inWait(f,bounded);f.c.requestProgress.coveredCalls=COVERED_CALLS;f.c.requestProgress.kittedTrip=true;f.c.tripEnded=Teammate.prototype.tripEnded
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.equal(f.events.find(e=>e.type==='hold_bounded')?.next,'trip_end',JSON.stringify(f.events))
 assert.ok(f.said.some(t=>/^The Nether trip is over: I held my shelter 1 minute with nothing gained\./.test(t)),f.said.join(' | '))
 assert.ok(!f.commands.some(x=>['unhut','shoot','unburrow','climb','flee','use_portal'].includes(x.action)),acts(f).join(' '))
 assert.equal(f.resumed.length,0)
})
test('a trip hold that keeps killing through the port is not cut short by the bound',async()=>{
 let kills=0
 const f=fixture(async()=>wait,{act:(cmd,bot)=>{
  if(cmd.action==='unhut')return {receipt:'unwalled',port:true,side:{dx:1,dz:0}}
  if(cmd.action==='hut')return {receipt:'walled_in',surface:{x:0,y:64,z:0}}
  if(cmd.action==='shoot'){if(++kills>=4)bot.entities={};return {receipt:'killed',shots:1,item:'blaze',at:{x:6.5,y:64,z:.5}}}}})
 blazeBeside(f,[6.5,64.2,.5]);inWait(f,{coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:60000,watches:1,holdBoundMs:1200}})
 f.c.safety.covered={from:{x:0,y:64,z:0},at:{x:0,y:64,z:0},moves:[]}
 const start=Date.now();await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.equal(kills,4,f.said.join(' | '));assert.ok(Date.now()-start>1200,'the kills ran past the bound');assert.deepEqual(f.events.filter(e=>e.type==='hold_bounded'),[])
})

// Review of the port-line gate, 16 October: off a trip (the play world's Overworld hut) nothing bounds a hold, so a
// shooter no port line reaches must still count toward the port attempts and the leave rule, as a port that opened
// and missed did: four times, then a strong bot with the shooter ten or more blocks off moves away. On a trip the same
// shooter holds the hut quietly, and the trip's hold bound backs that up. A pit east of the hut, a skeleton low in it
// eleven blocks off: the east exit sees it, the port's window does not.
function skeletonInPit(f,{nether=false}={}){
 f.cells.set('1,65,0','netherrack')
 for(let x=2;x<=14;x++)for(let y=57;y<=66;y++)for(let z=-3;z<=3;z++)f.cells.set(`${x},${y},${z}`,'air')
 f.bot.world={getColumn:()=>({}),raycast:(from,dir,range)=>{for(let d=0;d<=range;d+=.01){const c=from.plus(dir.scaled(d)).floored(),b=f.bot.blockAt(c);if(b.boundingBox==='block')return {name:b.name,position:c}}return null}}
 f.bot.entities={7:{id:7,uuid:'10000000-0000-0000-0000-000000000007',type:'mob',name:'skeleton',height:1.99,position:new Vec3(11.5,58,.5),velocity:new Vec3(0,0,0)}}
 if(!nether)f.bot.game.dimension='minecraft:overworld'
 setTimeout(()=>{f.bot.entities={}},6000)
}
test('off a trip a shooter no port line reaches still counts toward the port attempts and the leave rule; on a trip it holds quietly',async()=>{
 const opts={coveredMoves:false,burrowWait:{quietMs:50,limitMs:1500,patienceMs:50,relocateAfterMs:600000,watches:1}}
 const off=fixture(async()=>wait);skeletonInPit(off);inWait(off,opts)
 await Teammate.prototype.waitInBurrow.call(off.c,1,off.abort.signal,off.bot,true)
 assert.ok(!off.commands.some(x=>x.action==='unhut'&&x.goal?.shooter),'no port opens without a line: '+acts(off).join(' '))
 assert.ok(off.commands.some(x=>x.action==='flee'),'out of port attempts, it moves away: '+acts(off).join(' ')+' :: '+off.said.join(' | '))
 assert.equal(off.said.filter(t=>/No clear shot at the skeleton/.test(t)).length,1,off.said.join(' | '))
 const on=fixture(async()=>wait);skeletonInPit(on,{nether:true});inWait(on,opts)
 await Teammate.prototype.waitInBurrow.call(on.c,1,on.abort.signal,on.bot,true)
 assert.ok(!on.commands.some(x=>['unhut','shoot','climb','flee','use_portal'].includes(x.action)),acts(on).join(' ')+' :: '+on.said.join(' | '))
})

// Live rehearsal R9, 17 October 05:17:45Z to 05:18:10Z: at the stand cell -36,60,-9 the request planner was to call stand for
// four blaze rods. A blaze 2.3 below and a sealed-off wither skeleton raised the alarm, the bot walled in, and the covered
// planner answered done ("I'm walled in at the planned stand cell") as its brief told it, handing back to the request planner;
// the alarm fired again before that planner could act, the hut went up again, and done came again every 12 s, one covered
// model call a lap, never a stand. Under cover the stand is a covered move: admitted when the stand would start at this cell
// (blaze-stand.js blazeStandRefusal), dispatched from the hut, which the stand walls in and opens its own port from.
const standMove={action:'stand',target:null,count:4,expectation:'Four blaze rods from the stand'}
const standReceipt={receipt:'stand',item:'blaze_rod',count:4,rods:4,requested:4,partial:false,closed:true}
test('walled in at a valid stand cell with a blaze in view, the covered stand is admitted and dispatched as a blaze stand, with no done lap',async()=>{
 const seen=[];const f=fixture(async o=>{seen.push(o);return standMove},{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(f)
 const result=await f.run()
 assert.equal(seen[0].stand.refusal,null,'the observation says a stand starts here')
 const stands=f.commands.filter(x=>x.action==='stand');assert.equal(stands.length,1,acts(f).join(' ')+' :: '+JSON.stringify(f.c.recoveryHistory))
 assert.deepEqual(stands[0].goal,{item:'blaze_rod',count:4});assert.ok(stands[0].timeoutMs>=600000)
 assert.equal(seen.length,1,'one covered decision');assert.ok(!f.events.some(e=>e.type==='covered_decision'&&e.decision.action==='done'))
 assert.equal(f.c.requestProgress.coveredMoves,1)
 assert.equal(result.status,'handed_back');assert.equal(f.c.requestProgress.safetyContinuations.at(-1).receipt.receipt,'stand')
 assert.ok(!f.commands.some(x=>['unhut','hut','stop'].includes(x.action)),acts(f).join(' '))
})
test('a covered stand with count 0 takes the request\'s stand count, or 4',async()=>{
 const zero={...standMove,count:0}
 const asked=fixture(once(zero,wait),{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(asked)
 asked.c.requestProgress.pending=[{action:'stand',name:'',item:'blaze_rod',count:6,design:[]}]
 await asked.run();assert.deepEqual(asked.commands.find(x=>x.action==='stand')?.goal,{item:'blaze_rod',count:6},acts(asked).join(' '))
 const plain=fixture(once(zero,wait),{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(plain)
 await plain.run();assert.deepEqual(plain.commands.find(x=>x.action==='stand')?.goal,{item:'blaze_rod',count:4},acts(plain).join(' '))
})
// The stand opens its own port and takes its own hits (it closes on a hit, under 16): neither is a breach of the covered move.
// The stand's port on its task (task.portOpen) while it is open, as blaze-stand.js keeps it; shut, the record goes.
const portOpenFor=(f,open)=>{f.c.runner.task={kind:'stand',status:'running',...(open?{portOpen:[{x:1,y:65,z:0}]}:{})}}
test('the stand\'s own open port is not a cavity breach: no stop, no hut, the receipt comes back',async()=>{
 const f=fixture(async()=>standMove,{act:async(cmd,bot,m)=>{if(cmd.action!=='stand')return;portOpenFor(f,true);m.set('1,65,0','air');await new Promise(r=>setTimeout(r,40));bot.health=17;m.set('1,65,0','cobblestone');portOpenFor(f,false);await new Promise(r=>setTimeout(r,30));return standReceipt}});blazeBeside(f)
 const result=await f.run()
 assert.equal(result.status,'handed_back',JSON.stringify(f.c.recoveryHistory));assert.deepEqual(acts(f),['stand'])
})
// Round two (live rehearsal R9, design section 4.1 rule 1): the spawner's reach no longer refuses the bot's own cell, since a
// one-wide hut with the bot in it has no room for a spawned blaze. Refused for another reason (off the ground, no hut site),
// the covered stand is refused with the stand's reason and nothing is dispatched, as before.
test('the stand is admitted at a cell inside the spawner\'s reach when the hut cavity is the bot\'s own',async()=>{
 const seen=[];const f=fixture(async o=>{seen.push(o);return standMove},{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(f);f.cells.set('3,63,0','spawner')
 const result=await f.run()
 assert.equal(seen[0].stand.refusal,null,'the observation says a stand starts here');assert.deepEqual(acts(f),['stand']);assert.equal(result.status,'handed_back')
 const off=[];const g=fixture(async o=>{off.push(o);return off.length===1?standMove:wait});blazeBeside(g);g.bot.entity.onGround=false
 await g.run({budgetMs:60})
 assert.deepEqual(acts(g),[]);assert.match(off[0].stand.refusal,/No wall-in site here: Not standing on solid ground/)
 assert.ok(off[1]?.recovery.recentAttempts.some(a=>a.status==='rejected'&&/Not standing on solid ground/.test(a.reason)),JSON.stringify(off[1]?.recovery.recentAttempts))
})
test('the covered schema takes stand with no target and a count 0 to 8, and the prompt offers stand at a valid stand cell instead of done',async()=>{
 for(const ok of [standMove,{...standMove,count:0},{...standMove,count:8}])assert.deepEqual(validateCovered(ok),{...ok,target:null})
 for(const bad of [{...standMove,target:{x:0,y:64,z:0}},{...standMove,count:9},{...standMove,count:-1}])assert.throws(()=>validateCovered(bad),/Invalid covered decision/,JSON.stringify(bad))
 const p=new LocalPlanner();let prompt='',format=null;p.structured=async(m,f)=>{prompt=m[0].content;format=f;return standMove}
 assert.equal((await p.covered({},new AbortController().signal)).action,'stand')
 assert.ok(format.properties.action.enum.includes('stand'))
 const brief=prompt.split('walled in on a Nether trip')[1]
 assert.match(brief,/stand \(/);assert.match(brief,/observation\.stand/);assert.ok(!/choose done: the planner calls stand/.test(brief),brief)
})
// Review of the R9 fix: at a stand cell with a blaze already in port sight, the atPort shortcut held the phase with no model
// call, so the watch's port answered and the stand never ran: an endless port hold. On a blaze rod request at a valid stand
// cell the planner is asked instead (the stand handles its own port); off a stand cell, or for anything else, atPort holds.
test('at a valid stand cell with a blaze in port line, a blaze rod request asks the planner and dispatches the stand, never held',async()=>{
 const {atPort}=await import('../src/companion/covered-moves.js')
 let calls=0;const f=fixture(async()=>{calls++;return standMove},{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(f,[6.5,64.2,.5])
 assert.equal(atPort(f.bot)?.name,'blaze','the blaze is in port sight')
 const result=await f.run()
 assert.notEqual(result.status,'held',JSON.stringify(result));assert.equal(result.status,'handed_back')
 assert.equal(calls,1,'one covered model call');assert.deepEqual(acts(f),['stand'])
})
test('off a stand cell, or on a request without blaze rods, a blaze in port line still holds the phase with no model call',async()=>{
 for(const [name,set] of [['off the ground',f=>{f.bot.entity.onGround=false}],['an ender pearl request',f=>{f.c.requestProgress.request='ender pearls'}]]){
  let calls=0;const f=fixture(async()=>{calls++;return standMove});blazeBeside(f,[6.5,64.2,.5]);set(f)
  const result=await f.run()
  assert.equal(result.status,'held',name);assert.match(result.reason,/in sight through a port/,name);assert.equal(calls,0,name);assert.deepEqual(acts(f),[],name)
 }
})

// Review of the covered stand (Sonnet, 17 October): while the stand ran, the covered guard watched only for a changed
// context and liquid, the alarm could not fire (the covered phase holds the safety), and the stand's heal waited up to a
// minute for 16 health checking nothing. A wither skeleton or hoglin through a broken wall hit the bot unanswered. With the
// port shut the guard is the covered move's: the cavity and the health line. Only the stand's own open port relaxes it.
const wait20=ms=>new Promise(r=>setTimeout(r,ms))
test('a hit during a stand with its port shut stops the stand on the first damage and hands the hut back to the watch',async()=>{
 const f=fixture(async()=>standMove,{act:async(cmd,bot)=>{if(cmd.action!=='stand')return;portOpenFor(f,false);await wait20(20);bot.health=17;await wait20(60);return standReceipt}});blazeBeside(f)
 const result=await f.run()
 assert.equal(result.status,'held');assert.match(result.reason,/Health fell/);assert.ok(f.commands.some(x=>x.action==='stop'),acts(f).join(' '))
})
test('a breach of a hut wall during a stand with its port shut stops it and walls in again',async()=>{
 const f=fixture(async()=>standMove,{act:async(cmd,bot,m)=>{if(cmd.action==='hut'){for(let x=-1;x>-300;x--)m.delete(`${x},64,0`);return {receipt:'walled_in',surface:{x:0,y:64,z:0}}}
  if(cmd.action!=='stand')return;portOpenFor(f,false);await wait20(20);for(let x=-1;x>-300;x--)m.set(`${x},64,0`,'air');await wait20(60);return standReceipt}});blazeBeside(f)
 await f.run({budgetMs:200})
 const order=acts(f);assert.deepEqual(order.slice(0,2),['stand','hut'],order.join(' '))
 assert.ok(f.commands.some(x=>x.action==='stop'));assert.ok(f.c.recoveryHistory.some(a=>a.status==='rejected'&&/opened the cavity/.test(a.reason)),JSON.stringify(f.c.recoveryHistory))
})
test('after a failed stand the health line restarts from where the stand left it: the next decision is asked',async()=>{
 const seen=[];const f=fixture(async o=>{seen.push(o);return seen.length===1?standMove:wait},{act:(cmd,bot)=>{if(cmd.action!=='stand')return;bot.health=17;throw new Error('No blaze rod gained: 1 blaze killed, 1 port opened; hit at the port')}});blazeBeside(f)
 const result=await f.run({budgetMs:80})
 assert.ok(seen.length>=2,JSON.stringify(result));assert.ok(!/Health fell/.test(result.reason||''),JSON.stringify(result))
 assert.ok(f.c.recoveryHistory.some(a=>a.status==='failed'&&/No blaze rod gained/.test(a.reason)),JSON.stringify(f.c.recoveryHistory))
})

// Review of the atPort skip (Sonnet, 17 October): the skip at a stand cell took any shooter, so a skeleton or a ghast in port
// sight there was no longer answered from the port. Only a blaze is the stand's. And a backstop: two answers in a row that
// leave the stand unused at a valid stand cell on a blaze rod request (wait or done), and the stand is dispatched directly.
function skeletonInLine(f){blazeBeside(f);f.bot.entities[8]={id:8,uuid:'10000000-0000-0000-0000-000000000008',type:'mob',name:'skeleton',height:1.99,position:new Vec3(6.5,64.2,.5),velocity:new Vec3(0,0,0)}}
test('at a valid stand cell a skeleton in port sight still holds the phase for the port, with no model call',async()=>{
 const {atPort}=await import('../src/companion/covered-moves.js')
 let calls=0;const f=fixture(async()=>{calls++;return standMove});skeletonInLine(f)
 assert.equal(atPort(f.bot)?.name,'skeleton')
 const result=await f.run()
 assert.equal(result.status,'held');assert.match(result.reason,/skeleton is in sight through a port/);assert.equal(calls,0);assert.deepEqual(acts(f),[])
})
test('after two answers that leave the stand unused at a valid stand cell, the stand is dispatched with no model call',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {action:'done',target:null,count:0,expectation:'The planner calls stand'}},{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(f)
 const safety=structuredClone(f.c.safety),again=()=>{f.c.safety=structuredClone(safety);f.c.requestProgress.status='interrupted'}
 assert.equal((await f.run()).status,'handed_back');again()
 assert.equal((await f.run()).status,'handed_back');again()
 assert.deepEqual(acts(f),[],'two done laps, no stand yet');assert.equal(calls,2)
 const third=await f.run()
 assert.equal(calls,2,'no third model call');assert.deepEqual(acts(f),['stand']);assert.deepEqual(f.commands.find(x=>x.action==='stand').goal,{item:'blaze_rod',count:4})
 assert.equal(third.status,'handed_back');assert.ok(f.c.recoveryHistory.some(a=>/dispatched directly/.test(a.expectation||'')),JSON.stringify(f.c.recoveryHistory))
 assert.deepEqual(f.events.filter(e=>e.type==='stand_forced').map(e=>e.skips),[2],'the forced dispatch is logged')
})

// Live rehearsal R9b, 17 October 06:05:48Z: shut and healing after a fireball at the port, the bot burned 1 health a tick
// with no fire block in or around the hut. The covered guard reads that as a burn, not a breach: the stand goes on. Alight
// with fire in the hut's cavity, it stops the stand as a breach.
const burningStand=(f,{fire=false}={})=>async(cmd,bot,m)=>{
 if(cmd.action==='hut'){m.delete('0,64,0');bot.entity.metadata[0]=0;return {receipt:'walled_in',surface:{x:0,y:64,z:0}}}
 if(cmd.action!=='stand')return
 portOpenFor(f,false);bot.entity.metadata[0]=1;if(fire)m.set('0,64,0','fire')
 for(let i=0;i<4;i++){await wait20(15);bot.health-=1}
 bot.entity.metadata[0]=0;m.delete('0,64,0');return standReceipt
}
test('alight in a stand with its port shut and no fire in the hut, the burn ticks do not stop the stand',async()=>{
 const f=fixture(async()=>standMove,{act:(...a)=>burningStand(f)(...a)});blazeBeside(f)
 const result=await f.run()
 assert.equal(result.status,'handed_back',JSON.stringify(result));assert.ok(!f.commands.some(x=>x.action==='stop'),acts(f).join(' '));assert.deepEqual(acts(f),['stand'])
 assert.equal(f.bot.health,16)
})
test('alight in a stand with its port shut and fire in the hut\'s cavity, the stand is stopped',async()=>{
 const f=fixture(async()=>standMove,{act:(...a)=>burningStand(f,{fire:true})(...a)});blazeBeside(f)
 await f.run({budgetMs:200})
 assert.ok(f.commands.some(x=>x.action==='stop'),acts(f).join(' '));assert.deepEqual(acts(f).slice(0,2),['stand','hut'])
})

// Live rehearsal R9, 17 October 06:17:41Z (design of the blaze endgame, round two, section 3): the stall retry's resume
// cancelled the request, which aborted the signal the covered phase runs on. The stand's execute rejected at once, the finally
// cleared the monitor before its next poll could stop the task, and the phase returned cancelled with the stand still
// running, orphaned, while the planner thought. A covered move whose own signal aborts while its task runs stops that task.
test('a covered move whose signal aborts while its task still runs stops that task',async()=>{
 const f=fixture(async()=>standMove);blazeBeside(f)
 f.c.execute=(cmd,signal,started=()=>{})=>{f.commands.push(cmd);f.c.runner.task={id:'9',kind:cmd.action,status:'running',goal:cmd.goal};started('9')
  setTimeout(()=>f.abort.abort(),20)
  return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}))}
 const result=await f.run()
 assert.equal(result.status,'cancelled')
 assert.deepEqual(f.commands.map(x=>x.action),['stand','stop'],'the running stand is stopped, once')
 // A move that finished on its own is not stopped after it.
 const done=fixture(async()=>standMove,{act:cmd=>cmd.action==='stand'?standReceipt:undefined});blazeBeside(done)
 await done.run();assert.ok(!done.commands.some(x=>x.action==='stop'),done.commands.map(x=>x.action).join(' '))
})
// Live rehearsal, 20 October: walled in beside the spawner, every covered decision was cut at the
// 30-second wait ("Covered decision budget reached") because the subscription planner answers slower
// than that, so the phase could never move and the hut looped. The per-decision wait's default must sit
// inside the planner's own budget (PLAN_TIMEOUT_MS), not far under it.
test('a covered decision slower than thirty seconds of poll time is still heard under the default wait',async()=>{
 assert.ok(MODEL_DECISION_MS>=240000,`MODEL_DECISION_MS=${MODEL_DECISION_MS}`)
 const slow=async()=>{await new Promise(r=>setTimeout(r,150));return {action:'done',target:null,count:0,expectation:'Hand back'}}
 const f=fixture(slow)
 const result=await coveredMoves(f.c,1,f.abort.signal,f.bot,{eligible:true,budgetMs:5000,pollMs:2,waitMs:5})
 assert.equal(result.status,'handed_back')
})
