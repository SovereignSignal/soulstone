import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {threatState,judgeThreat,harnessVerdict,resolveKey,ThreatJudge,THREAT_QUESTIONS,wornArmour} from '../src/threat-judgement.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
const registry=minecraftData('1.21.4')
const observation={health:14,food:16,timeOfDay:14000,difficulty:'normal',carriedFood:[{name:'cooked_beef',count:2}],nearbyThreats:[{name:'skeleton',distance:12.5,risk:'potential_hostile'},{name:'spider',distance:20,risk:'conditional'}]}
const answer={model:'jev-latest',answers:{response:{type:'choice',choice:'shelter',probabilities:{fight:.1,evade:.2,shelter:.6,continue:.1},confidence:.62},interrupt:{type:'noul',noul:.8},danger:{type:'score',score:1.9,legend:{},probabilities:{},confidence:.7},winnable:{type:'noul',noul:.15}},usage:{input_tokens:900,output_tokens:40}}
const fakeFetch=(calls,body=answer,status=200)=>async(url,init)=>{calls.push({url,init:JSON.parse(init.body)});return {ok:status<400,status,json:async()=>body}}

test('the state names what the model cannot infer from numbers: weapon damage, ranged mobs, day phase, shelter',()=>{
 const s=threatState(observation,{weapon:'stone_axe',armour:['leather_helmet'],tools:['stone_axe','wooden_pickaxe'],inventory:{cobblestone:12,torch:3,stone_axe:1},sheltered:false,shelterAvailable:true,baseDistance:41.6})
 assert.equal(s.agent.health,'14 of 20');assert.equal(s.agent.bestMeleeWeapon,'stone axe (9 damage per hit)');assert.equal(s.agent.armourWorn,'leather helmet')
 assert.deepEqual(s.agent.blocksCarried,['12 cobblestone']);assert.equal(s.agent.torches,3);assert.equal(s.agent.litBase,'available, 42 blocks away')
 assert.equal(s.world.phase,'night');assert.deepEqual(s.agent.carriedFood,['2 cooked beef'])
 assert.deepEqual(s.threats.map(t=>[t.mob,t.attacksFromRange,t.risk.startsWith('neutral')]),[['skeleton',true,false],['spider',false,true]])
 assert.equal(threatState({},{}).agent.bestMeleeWeapon,'none (bare hands, 1 damage per hit)');assert.equal(threatState({},{}).agent.litBase,'none')
})
test('one request carries four independent questions and the answer maps onto flat fields',async()=>{
 const calls=[];const j=await judgeThreat(threatState(observation),{fetch:fakeFetch(calls),key:'k',model:'jev-latest'})
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.typesafe.ai/v1/systemone')
 assert.deepEqual(Object.keys(calls[0].init.questions),['response','interrupt','danger','winnable']);assert.equal(calls[0].init.model,'jev-latest');assert.equal(calls[0].init.state.agent.health,'14 of 20')
 assert.equal(j.response,'shelter');assert.equal(j.confidence,.62);assert.equal(j.interrupt,.8);assert.equal(j.danger,1.9);assert.equal(j.winnable,.15);assert.equal(j.inputTokens,900);assert.ok(Number.isFinite(j.latencyMs))
 assert.equal(THREAT_QUESTIONS.danger.criteria.length,4)
})
test('a missing key, an HTTP error, a malformed answer and a slow endpoint are all ordinary failures',async()=>{
 await assert.rejects(judgeThreat({},{fetch:fakeFetch([]),key:''}),/No TypeSafe key/)
 await assert.rejects(judgeThreat({},{fetch:fakeFetch([],{error:'bad'},401),key:'k'}),/HTTP 401/)
 await assert.rejects(judgeThreat({},{fetch:fakeFetch([],{answers:{response:{choice:'fight'}}}),key:'k'}),/missing a question/)
 const hang=async(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))))
 await assert.rejects(judgeThreat({},{fetch:hang,key:'k',timeoutMs:20}),/did not answer within 20ms/)
})
test('the harness verdict speaks the judge\'s vocabulary',()=>{
 assert.deepEqual(harnessVerdict({engage:true,target:{targetName:'zombie'},weapon:'wooden_axe'},observation),{verdict:'fight',reason:'defend against the zombie with the wooden axe'})
 assert.equal(harnessVerdict({engage:false,reason:'x'},{nearbyThreats:[{name:'creeper',risk:'potential_hostile',distance:15}]}).verdict,'evade')
 assert.deepEqual(harnessVerdict({engage:false,reason:'Threat type or nearby numbers exceed basic melee defense'},observation),{verdict:'shelter',reason:'Threat type or nearby numbers exceed basic melee defense'})
})
test('the key comes from the environment, or the Keychain only for a packaged launch, and MC_THREAT_JUDGE=0 turns it off',()=>{
 assert.equal(resolveKey({TYPESAFE_API_KEY:'abc'}),'abc')
 assert.equal(resolveKey({TYPESAFE_API_KEY:'abc',MC_THREAT_JUDGE:'0'}),null)
 assert.equal(resolveKey({},'darwin'),null,'a developer run never touches the Keychain')
 assert.equal(resolveKey({MC_SETUP_FILE:'/x'},'linux'),null)
})
test('without a key the judge is silent after one notice; with one it logs each judgement with agreement, throttles watching and stops logging repeated failures',async()=>{
 const events=[];const off=new ThreatJudge({key:null,log:(t,d)=>events.push([t,d])})
 assert.equal(await off.judge('interruption',observation,{harness:'shelter'}),null);assert.deepEqual(events.map(e=>e[0]),['threat_judgement_disabled'])
 events.length=0;let now=100000;const calls=[]
 const on=new ThreatJudge({key:'k',fetch:fakeFetch(calls),log:(t,d)=>events.push([t,d]),now:()=>now,minWatchIntervalMs:15000})
 const j=await on.judge('interruption',observation,{harness:'shelter',harnessReason:'r',weapon:'wooden_axe'})
 assert.equal(j.agrees,true);assert.equal(j.harness,'shelter');assert.equal(j.state.agent.bestMeleeWeapon,'wooden axe (7 damage per hit)');assert.equal(events.at(-1)[0],'threat_judgement');assert.equal(events.at(-1)[1].kind,'interruption')
 assert.ok(await on.judge('watch',observation,{harness:'continue'}));assert.equal(await on.judge('watch',observation,{harness:'continue'}),null,'a second watch inside the interval is skipped')
 now+=15000;assert.ok(await on.judge('watch',observation,{harness:'continue'}));assert.equal(calls.length,3)
 const failing=new ThreatJudge({key:'k',fetch:fakeFetch([],{error:'down'},500),log:(t,d)=>events.push([t,d])});events.length=0
 for(let i=0;i<5;i++)assert.equal(await failing.judge('interruption',observation,{}),null)
 assert.equal(events.filter(e=>e[0]==='threat_judgement_failed').length,3);assert.match(events.at(-1)[1].note,/not logged/)
})
test('worn armour is read from the equipment slots, the way armor.js does',()=>{
 const slots=[];slots[5]={name:'iron_helmet'};slots[8]={name:'leather_boots'}
 const bot={inventory:{slots},getEquipmentDestSlot:s=>({head:5,torso:6,legs:7,feet:8})[s]}
 assert.deepEqual(wornArmour(bot),['iron_helmet','leather_boots']);assert.deepEqual(wornArmour({}),[])
})
test('a threat interruption asks the judge at the moment the chain decides, with the rule\'s own verdict beside it, and never waits for the answer',async()=>{
 const inventory=[{name:'cobblestone',count:8},{name:'cobblestone',count:4},{name:'wooden_pickaxe',count:1,maxDurability:59,durabilityUsed:0}]
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:20,food:20,players:{},
  entities:{1:{id:1,uuid:'0'.repeat(36),type:'mob',name:'zombie',position:new Vec3(16.5,64,10.5)},2:{id:2,uuid:'1'.repeat(36),type:'mob',name:'skeleton',position:new Vec3(6.5,64,10.5)}},
  entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inventory,slots:[]},getEquipmentDestSlot:()=>null,
  blockAt:p=>({name:p.y>=64?'air':'dirt',position:p.clone(),boundingBox:p.y>=64?'empty':'block'}),pathfinder:{setGoal(){},setMovements(){},async goto(){}},clearControlStates(){},async equip(){},async dig(){},async placeBlock(){}}
 const runner=new EventEmitter();runner.bot=bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 runner.command=c=>{if(c.action==='stop')return;runner.task={id:'t',kind:c.action,status:'running'};setTimeout(()=>{runner.task={...runner.task,status:'failed',error:'test'};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const asked=[];let release;const answered=new Promise(r=>{release=r})
 const threatJudge={judge:async(kind,observation,extras)=>{asked.push({kind,observation,extras});await answered;return {response:'evade',confidence:.5,interrupt:.6,danger:1.2,winnable:.2,harness:extras.harness,agrees:false}}}
 const c={runner,projects:{base:{build:{origin:{x:40,y:64,z:10}}}},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,threatJudge,burrowWait:{quietMs:20,limitMs:50},
  say(){},persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},judgementContext:Teammate.prototype.judgementContext,
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:async()=>{},moveOutOfDanger:async()=>false,leaveOnOpenGround:async()=>'skipped',waitInBurrow:async()=>{},safetyBlockKey:()=>'k',snapshot:()=>({dead:false}),async resume(){}}
 await Promise.race([c.seekSafety(THREAT_INTERRUPTION),new Promise(r=>setTimeout(r,1500))])
 assert.equal(asked.length,1,'the chain must not wait on the judge');assert.equal(asked[0].kind,'interruption')
 assert.equal(asked[0].extras.harness,'shelter');assert.match(asked[0].extras.harnessReason,/Threat type or nearby numbers/)
 assert.deepEqual(asked[0].observation.nearbyThreats.map(t=>t.name),['skeleton','zombie'])
 assert.deepEqual(asked[0].extras.inventory,{cobblestone:12,wooden_pickaxe:1});assert.deepEqual(asked[0].extras.tools,['wooden_pickaxe']);assert.equal(asked[0].extras.weapon,null);assert.equal(Math.round(asked[0].extras.baseDistance),30)
 c.safety={status:'retreating'};release();await new Promise(r=>setTimeout(r,5))
 assert.deepEqual(c.safety.judgement,{response:'evade',confidence:.5,interrupt:.6,danger:1.2,winnable:.2,harness:'shelter',agrees:false})
})

// ---- control mode ----
import {forcedInterruption,gateVerdict,chooseResponse,FLOORS} from '../src/threat-judgement.js'
import {defenseDecision} from '../src/combat.js'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const hostile=(name,distance,extra={})=>({name,distance,risk:'potential_hostile',position:{x:distance,y:64,z:0},...extra})
test('the floors are not judgement calls: melee reach, creeper fuse range and low health always interrupt',()=>{
 assert.equal(forcedInterruption({health:20,nearbyThreats:[hostile('zombie',9)]}),null)
 assert.match(forcedInterruption({health:20,nearbyThreats:[hostile('zombie',5.5)]}),/melee/)
 assert.match(forcedInterruption({health:20,nearbyThreats:[hostile('creeper',9)]}),/creeper/)
 assert.match(forcedInterruption({health:8,nearbyThreats:[]}),/health/)
 assert.equal(forcedInterruption({health:20,nearbyThreats:[{name:'spider',distance:2,risk:'conditional'}]}),null,'a conditional mob is not a hostile')
})
test('the gate lets work continue on a judged continue or a low interrupt probability, and interrupts when Jev did not answer',()=>{
 assert.equal(gateVerdict({response:'continue',interrupt:.7}),'continue')
 assert.equal(gateVerdict({response:'shelter',interrupt:.3}),'continue')
 assert.equal(gateVerdict({response:'shelter',interrupt:.6}),'interrupt')
 assert.equal(gateVerdict(null),'interrupt')
})
test('the response follows Jev when it is sure, defers to the rule when it is not, and reads continue as evade',()=>{
 assert.deepEqual(chooseResponse({response:'fight',confidence:.7},'shelter'),{response:'fight',source:'jev'})
 assert.deepEqual(chooseResponse({response:'fight',confidence:.2},'shelter'),{response:'shelter',source:'rule (judgement unsure)'})
 assert.deepEqual(chooseResponse(null,'evade'),{response:'evade',source:'rule (no judgement)'})
 assert.equal(chooseResponse({response:'continue',confidence:.6},'shelter').response,'evade')
 assert.equal(FLOORS.fightHealth,10)
})
function arena({health=11,food=12,mob='zombie',distance=5,weapon='wooden_axe'}={}){
 const inventory=weapon?[{name:weapon,count:1,maxDurability:59,durabilityUsed:0}]:[]
 const entities={1:{id:1,uuid:'a'.repeat(36),type:'mob',name:mob,position:new Vec3(10.5+distance,64,10.5)}}
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:6000},health,food,players:{},entities,
  entity:{position:new Vec3(10.5,64,10.5),onGround:true,isInWater:false,isInLava:false},inventory:{items:()=>inventory,slots:[]},getEquipmentDestSlot:()=>null,currentWindow:null,
  blockAt:p=>({name:p.y>=64?'air':'dirt',position:p.clone(),boundingBox:p.y>=64?'empty':'block'}),pathfinder:{setGoal(){},setMovements(){},async goto(){}},clearControlStates(){},async equip(){},async dig(){},async placeBlock(){},world:{getColumn:()=>null}}
 return bot
}
test('a judged fight lowers the rule margins to the floors and never below them',()=>{
 const bot=arena({health:11,food:12})
 assert.match(defenseDecision(bot).reason,/too low/)
 const relaxed=defenseDecision(bot,{healthFloor:FLOORS.fightHealth,foodFloor:FLOORS.fightFood,mobMargins:false})
 assert.equal(relaxed.engage,true);assert.equal(relaxed.target.targetName,'zombie');assert.equal(relaxed.weapon,'wooden_axe')
 assert.match(defenseDecision(arena({health:9}),{healthFloor:10,foodFloor:8,mobMargins:false}).reason,/too low/)
 assert.match(defenseDecision(arena({health:15,mob:'skeleton'})).reason,/skeleton/,'the rule keeps its skeleton margin')
 assert.equal(defenseDecision(arena({health:15,mob:'skeleton'}),{mobMargins:false}).engage,true)
})
function controlled(c,answers){
 const asked=[];const judge={control:true,floors:FLOORS,judge:async(kind,observation,extras)=>{asked.push({kind,harness:extras.harness});const a=answers[kind]??null;return a&&{...a,harness:extras.harness,agrees:null}}}
 return [judge,asked]
}
function seekScaffold(bot,{onCommand}={}){
 const runner=new EventEmitter();runner.bot=bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov';const commands=[];const logged=[];runner.log=(t,d)=>logged.push([t,d])
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'};onCommand?.(c)
  setTimeout(()=>{runner.task={...runner.task,status:c.action==='defend'?'failed':'completed',result:{receipt:c.action},error:c.action==='defend'?'test stops the fight':undefined};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:50},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},judgementContext:Teammate.prototype.judgementContext,judgedEvade:Teammate.prototype.judgedEvade,
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:async()=>{},moveOutOfDanger:async()=>false,leaveOnOpenGround:async()=>'skipped',waitInBurrow:async()=>{},safetyBlockKey:()=>'k',snapshot:()=>({dead:false}),async resume(){resumed++;this.requestProgress.status='running'}}
 return {c,commands,said,logged,resumed:()=>resumed}
}
test('in control mode a confident Jev fight overrides the rule\'s shelter, within the floors',async()=>{
 const bot=arena({health:11,food:12});const {c,commands,said,logged}=seekScaffold(bot)
 const [judge]=controlled(c,{interruption:{response:'fight',confidence:.7,interrupt:.8,danger:1.5,winnable:.75}});c.threatJudge=judge
 await Promise.race([c.seekSafety(THREAT_INTERRUPTION),new Promise(r=>setTimeout(r,1500))])
 assert.ok(commands.includes('defend'),commands.join(','));assert.ok(said.some(t=>/Judgement: fight \(jev/.test(t)),said.join(' | '))
 assert.deepEqual(logged.find(l=>l[0]==='threat_control')[1],{chosen:'fight',source:'jev',rule:'shelter',jev:'fight',confidence:.7,winnable:.75,danger:1.5})
})
test('in control mode an unsure Jev defers to the rule',async()=>{
 const bot=arena({health:11,food:12});const {c,commands,said}=seekScaffold(bot)
 const [judge]=controlled(c,{interruption:{response:'fight',confidence:.2,interrupt:.8,danger:1.5,winnable:.5}});c.threatJudge=judge
 await Promise.race([c.seekSafety(THREAT_INTERRUPTION),new Promise(r=>setTimeout(r,1500))])
 assert.ok(!commands.includes('defend'));assert.ok(said.some(t=>/Judgement: shelter \(rule \(judgement unsure\)/.test(t)),said.join(' | '))
})
test('a judged evade flees the nearest hostile and resumes the request when nothing followed',async()=>{
 const bot=arena({health:20,food:20,distance:8});const {c,commands,said,resumed}=seekScaffold(bot,{onCommand:cmd=>{if(cmd.action==='flee')bot.entities={}}})
 const [judge]=controlled(c,{interruption:{response:'evade',confidence:.6,interrupt:.7,danger:1.2,winnable:.3}});c.threatJudge=judge
 await c.seekSafety(THREAT_INTERRUPTION)
 assert.deepEqual(commands.filter(a=>a!=='stop'),['flee']);assert.equal(resumed(),1);assert.equal(c.safety,null)
 assert.equal(c.requestProgress.safetyContinuations[0].shelter,'judged_evade');assert.ok(said.some(t=>/Judged evade/.test(t)))
})
test('the gate lets a judged continue keep the bot working, holds for a while, and interrupts when Jev says so or the floors do',async()=>{
 const bot=arena({health:20,food:20,distance:9});const runner=new EventEmitter();runner.bot=bot;runner.ready=true;runner.profile='p';runner.owner='Sov';runner.position=()=>({x:10,y:64,z:10});const logged=[];runner.log=(t,d)=>logged.push([t,d])
 const t=new Teammate(runner,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-jev-')),'state.json'))
 let answer={response:'continue',confidence:.6,interrupt:.2,danger:.4,winnable:.5};const asked=[];let sought=[]
 t.threatJudge={control:true,floors:{...FLOORS,holdMs:60},judge:async(kind)=>{asked.push(kind);return {...answer,agrees:null}}};t.seekSafety=async r=>{sought.push(r)}
 const tick=async()=>{runner.emit('event',{type:'survival_tick'});await new Promise(r=>setTimeout(r,10))}
 await tick();assert.deepEqual(asked,['gate']);assert.deepEqual(sought,[]);assert.ok(t.threatHold);assert.equal(logged.find(l=>l[0]==='threat_gate')[1].verdict,'continue')
 await tick();assert.equal(asked.length,1,'the hold stops a second question');assert.deepEqual(sought,[])
 await new Promise(r=>setTimeout(r,70));answer={response:'shelter',confidence:.8,interrupt:.9,danger:2,winnable:.1}
 await tick();assert.equal(asked.length,2);assert.deepEqual(sought,[THREAT_INTERRUPTION]);assert.equal(t.threatHold,null)
 sought=[];bot.entities[1].position=new Vec3(14.5,64,10.5)
 await tick();assert.equal(asked.length,2,'a hostile in melee reach is not asked about');assert.deepEqual(sought,[THREAT_INTERRUPTION])
})
