import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {coveredMoves} from '../src/companion/covered-moves.js'
import {LocalPlanner,validateCovered} from '../src/companion/planner.js'
import {COVERED_MOVES} from '../src/companion/continuity.js'
const registry=minecraftData('1.21.4')
// Family rehearsal, 16 October: walled in beside the arrival portal at the Nether hub, the wait
// held "for daylight and a clear area", which never comes in the Nether, until "Resume is
// required". Walled in on a trip, the bot digs a shaft and bores under cover instead.
// A hut at 0,64,0: placed cobblestone walls and roof, netherrack everywhere else.
const limits={budgetMs:400,decisionMs:80,pollMs:2,waitMs:5}
const kit=()=>[{name:'bow',count:1},{name:'arrow',count:40},{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0},{name:'iron_pickaxe',count:1,maxDurability:250,durabilityUsed:0},{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]
const wall=p=>(p.y===64||p.y===65)&&Math.abs(p.x)+Math.abs(p.z)===1||p.y===66&&p.x===0&&p.z===0
function fixture(choose,{act}={}){
 const cells=new Map(),commands=[],events=[],abort=new AbortController(),said=[],resumed=[]
 const name=p=>cells.get(`${p.x},${p.y},${p.z}`)??(p.x===0&&p.z===0&&(p.y===64||p.y===65)?'air':wall(p)?'cobblestone':'netherrack')
 const items=kit(),slots=[]
 const bot={registry,health:20,food:20,oxygenLevel:20,game:{gameMode:'survival',difficulty:'normal',dimension:'minecraft:the_nether'},time:{timeOfDay:6000},
  entity:{position:new Vec3(.5,64,.5),onGround:true,metadata:[0]},entities:{},players:{},inventory:{items:()=>items,slots},getEquipmentDestSlot:s=>({head:5,torso:6,legs:7,feet:8})[s],
  blockAt(p){const n=name(p);return {name:n,position:p.clone(),boundingBox:registry.blocksByName[n]?.boundingBox,getProperties:()=>({})}}}
 for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'golden_boots']])slots[i]={name:n}
 const runner={bot,ready:true,connectionId:'c',log:(type,data)=>events.push({type,...data})}
 const c={runner,epoch:1,projects:{},safety:{status:'burrowed',retreat:{shelterName:'hut',surface:{x:0,y:64,z:0}}},requestProgress:{id:'r',request:'blaze rods',status:'interrupted',completed:[],feedback:[]},recoveryHistory:[],
  planner:{covered:choose},persist(){},say:text=>said.push(text),snapshot:()=>({inventory:{},position:bot.entity.position,health:bot.health}),dispatch:cmd=>commands.push(cmd),resume:async o=>{resumed.push(o)},
  async execute(cmd){commands.push(cmd);const result=await (act?.(cmd,bot,cells))??{receipt:cmd.action};runner.task={kind:cmd.action,status:'completed',result}}}
 // dig straight down: the column opens and the bot lands at its foot.
 if(!act)act=(cmd,b,m)=>{if(cmd.action==='dig'){for(let y=cmd.goal.y;y<64;y++)m.set(`0,${y},0`,'air');b.entity.position=new Vec3(.5,cmd.goal.y,.5);return {receipt:'dug',count:cmd.goal.count}}}
 return {bot,cells,c,commands,events,abort,said,resumed,run:(opts={})=>coveredMoves(c,1,abort.signal,bot,{eligible:true,...limits,...opts})}
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
test('bore from the hut is refused as shaft first; from the shaft foot in rock it dispatches with the target and protected sites',async()=>{
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
// Live, 16 October: the family seed's Nether arrival is on a fortress bridge of nether bricks, which
// the family rule never digs, so the shaft is refused there. From the hut a bore is admitted when its
// first column is the bot's own wall or rock, or open air over a solid floor that is not hot.
test('from a hut on a bridge, a bore through its own wall or across air over a cool floor is admitted; over magma or beside lava it is not',async()=>{
 const bore={action:'bore',target:{x:20,y:64,z:0},count:6,expectation:'Along the bridge'}
 const bridge=f=>{for(const [k,v] of [['0,63,0','nether_bricks'],['1,63,0','nether_bricks']])f.cells.set(k,v)}
 const own=fixture(once(bore,wait),{act:()=>({receipt:'bored',columns:1,slit:null})});bridge(own)
 own.bot.ownBlocks={has:()=>false,entry:p=>p.x===1&&p.z===0&&(p.y===64||p.y===65)?{name:'cobblestone'}:null}
 await own.run({budgetMs:60});assert.ok(own.commands.some(x=>x.action==='bore'),'own wall: '+JSON.stringify(own.c.recoveryHistory))
 const air=fixture(once(bore,wait),{act:()=>({receipt:'bored',columns:1,slit:null})});bridge(air);air.cells.set('1,64,0','air');air.cells.set('1,65,0','air')
 await air.run({budgetMs:60});assert.ok(air.commands.some(x=>x.action==='bore'),'air over bricks: '+JSON.stringify(air.c.recoveryHistory))
 for(const [name,set,re] of [['magma floor',f=>f.cells.set('1,63,0','magma_block'),/magma_block/],['lava beside',f=>f.cells.set('1,64,1','lava'),/lava/]]){
  // Lava beside is judged at the bot's own wall: beside an open column it would already be inside the hut's flood.
  const f=fixture(once(bore,wait));bridge(f);if(name==='magma floor'){f.cells.set('1,64,0','air');f.cells.set('1,65,0','air')}else f.bot.ownBlocks={has:()=>false,entry:p=>p.x===1&&p.z===0?{name:'cobblestone'}:null};set(f)
  await f.run({budgetMs:60});assert.deepEqual(acts(f),[],name);assert.ok(f.c.recoveryHistory.some(a=>a.status==='rejected'&&re.test(a.reason)),name+': '+JSON.stringify(f.c.recoveryHistory))
 }
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
 else if(change==='damage')await assert.rejects(run,/Health fell/)
 else assert.equal((await run).status,'cancelled')
 await new Promise(r=>setTimeout(r,60));assert.deepEqual(acts(f),[],change)
})
test('a move stops when health falls during it',async()=>{
 const f=fixture(once({action:'dig',target:{x:0,y:62,z:0},count:2,expectation:'Shaft'}),{act:async(cmd,bot)=>{bot.health=17;await new Promise(r=>setTimeout(r,30));return {receipt:'dug'}}})
 await assert.rejects(f.run(),/Health fell/);assert.ok(f.commands.some(x=>x.action==='stop'),acts(f).join(' '))
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
 const r=new EventEmitter();Object.assign(r,{ready:false,profile:'covered-test',owner:'Sov',commands:[],command(c){this.commands.push(c)},position:()=>null})
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},path)
 assert.equal(c.restoreBurrow,true);assert.deepEqual(c.safety.covered,covered)
})
