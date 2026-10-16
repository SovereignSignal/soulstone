import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {PortalTravel} from '../src/portal-travel.js'
import {usePortal,portalKind} from '../src/portal-guard.js'
import {DoorAwareMovements} from '../src/navigation.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const key=p=>`${p.x},${p.y},${p.z}`

// The dragon roadmap, brief 3: the End gate. The End has
// its own switch beside the Nether's, off unless the file says on.
test('the End is its own switch: off unless saved on, and a damaged file is all off',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mc-end-travel-')),path=join(dir,'portal-travel.json')
 const t=new PortalTravel(path)
 assert.equal(t.allows('the_end'),false);assert.equal(t.snapshot().end,'off')
 t.save({nether:'on'});assert.equal(t.allows('the_end'),false,'the Nether switch does not open the End')
 t.save({end:'on'})
 const again=new PortalTravel(path)
 assert.equal(again.allows('the_end'),true,'the setting survives a restart');assert.equal(again.allows('the_nether'),true,'saving one switch leaves the other')
 writeFileSync(path,'{"nether":"on","end":"sideways"}')
 const damaged=new PortalTravel(path)
 assert.equal(damaged.allows('the_end'),false,'a damaged file is off, not on');assert.equal(damaged.allows('the_nether'),false)
 writeFileSync(path,'{"nether":"on"}');assert.equal(new PortalTravel(path).allows('the_end'),false,'a file from before the switch keeps the End off')
})

// A stronghold portal room: a lit 3x3 end portal over lava, ringed by frames,
// on a stone brick floor. The End: the obsidian arrival platform at 100,48,0.
function stronghold({buried=null,fountain=false}={}){
 const worlds={overworld:new Map(),the_end:new Map()},log=[]
 const ow=worlds.overworld
 for(let x=-2;x<=9;x++)for(let z=-4;z<=4;z++)ow.set(key({x,y:29,z}),'stone_bricks')
 for(let x=3;x<=5;x++)for(let z=-1;z<=1;z++){ow.set(key({x,y:30,z}),'end_portal');ow.set(key({x,y:29,z}),'lava')}
 for(let z=-1;z<=1;z++){ow.set(key({x:2,y:30,z}),'end_portal_frame');ow.set(key({x:6,y:30,z}),'end_portal_frame')}
 for(let x=3;x<=5;x++){ow.set(key({x,y:30,z:-2}),'end_portal_frame');ow.set(key({x,y:30,z:2}),'end_portal_frame')}
 for(let x=98;x<=102;x++)for(let z=-2;z<=2;z++)worlds.the_end.set(key({x,y:48,z}),'obsidian')
 if(buried)worlds.the_end.set(key({x:100,y:50,z:0}),buried)
 if(fountain){for(let x=-3;x<=3;x++)for(let z=-3;z<=3;z++)worlds.the_end.set(key({x,y:60,z}),'end_stone');for(let x=-1;x<=1;x++)for(let z=-1;z<=1;z++)if(x||z)worlds.the_end.set(key({x,y:61,z}),'end_portal');worlds.the_end.set(key({x:0,y:61,z:0}),'bedrock')}
 const here=()=>String(bot.game.dimension).replace('minecraft:','')
 const name=p=>worlds[here()]?.get(key(p.floored()))??'air'
 const bot={registry,players:{},entities:{},health:20,food:20,game:{gameMode:'survival',difficulty:'hard',dimension:'minecraft:overworld'},inventory:{items:()=>[]},
  entity:{position:new Vec3(-.5,30,.5),onGround:true,metadata:{0:0},effects:[]},
  blockAt(p){const b=Block.fromStateId(registry.blocksByName[name(p)].defaultState,0);b.position=p.floored();return b},
  findBlock({matching,maxDistance}){log.push('find '+maxDistance);let best=null;for(const [k,n] of worlds[here()]){if(![matching].flat().includes(registry.blocksByName[n].id))continue;const p=new Vec3(...k.split(',').map(Number));const d=p.distanceTo(bot.entity.position);if(d<=maxDistance&&(!best||d<best.d))best={p,d}}return best?bot.blockAt(best.p):null},
  pathfinder:{setGoal(){},setMovements(){},async goto(g){log.push('walk '+[g.x,g.y,g.z]);bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}},
  tool:{async equipForBlock(){}},
  async dig(b){log.push('dig '+b.name);worlds[here()].delete(key(b.position))},
  async lookAt(p){bot.lookTarget=p},clearControlStates(){},
  setControlState(k,v){
   if(k==='jump')bot.entity.onGround=!v
   if(k==='forward'&&v&&bot.lookTarget){const t=bot.lookTarget.floored();log.push('step '+key(t));bot.entity.position=new Vec3(t.x+.5,t.y,t.z+.5)
    if(name(t)==='end_portal'&&!bot.carried){bot.carried=true;setTimeout(()=>{const to=here()==='overworld'?'the_end':'overworld';bot.game.dimension='minecraft:'+to;bot.entity.position=to==='the_end'?new Vec3(100.5,49,.5):new Vec3(-.5,30,.5);log.push('crossed')},20)}}}}
 return {bot,worlds,log,api:{check(){},stage(){},progress(m){log.push('say '+m)},movements:null}}
}

test('use_portal from the Overworld with the End off refuses by name, without a step toward the portal',async()=>{
 const f=stronghold()
 await assert.rejects(usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true,endAllowed:false},{pollMs:5}),/travel to the End is off for this world/)
 assert.ok(!f.log.some(l=>/^(walk|step)/.test(l)),f.log.join(' | '))
})

test('with the End on, use_portal finds the end portal within 48, steps onto it and lands in the End',async()=>{
 const f=stronghold()
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,endAllowed:true},{pollMs:5})
 assert.ok(f.log.includes('find 48'),f.log.join(' | '))
 assert.equal(r.receipt,'crossed');assert.equal(r.from.dimension,'overworld');assert.equal(r.to.dimension,'the_end')
 assert.equal(f.worlds.overworld.get(key(r.from.portal)),'end_portal','the receipt names the portal stepped onto')
 assert.deepEqual(r.to.portal,{x:100,y:49,z:0},'the arrival platform is the far end of the link')
 assert.ok(f.log.some(l=>/^step [3-5],30,/.test(l)),'stepped onto a portal cell: '+f.log.join(' | '))
 assert.ok(!f.log.some(l=>/^dig/.test(l)),'an open platform needs no digging')
})

test('a buried arrival digs out through end stone, and never through obsidian',async()=>{
 const f=stronghold({buried:'end_stone'})
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,endAllowed:true},{pollMs:5})
 assert.equal(r.to.dimension,'the_end');assert.ok(f.log.includes('dig end_stone'),f.log.join(' | '))
 const g=stronghold({buried:'obsidian'})
 await assert.rejects(usePortal(g.bot,{kind:'use_portal',goal:{}},{...g.api,endAllowed:true},{pollMs:5}),/obsidian/)
 assert.ok(!g.log.some(l=>/^dig/.test(l)),g.log.join(' | '))
 assert.ok(!g.log.some(l=>/dig .*obsidian/.test(l)))
})

test('the End dig-out never digs bedrock',async()=>{
 const f=stronghold({buried:'bedrock'})
 await assert.rejects(usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,endAllowed:true},{pollMs:5}),/bedrock/)
 assert.ok(!f.log.some(l=>/^dig/.test(l)),f.log.join(' | '))
})

// Review of brief 3: a nearer end portal with the End off hid a lit nether portal
// the switch allows. The nearest allowed portal is the one meant.
test('with both portals in reach, use_portal takes the nearest one its switches allow',async()=>{
 const f=stronghold();f.worlds.overworld.set('-6,30,0','nether_portal');f.worlds.overworld.set('-6,31,0','nether_portal')
 assert.equal(portalKind(f.bot,{netherAllowed:true,endAllowed:false}),'nether','the End off: the nether portal, though further')
 assert.equal(portalKind(f.bot,{netherAllowed:true,endAllowed:true}),'end','both on: the nearer')
 assert.equal(portalKind(f.bot,{netherAllowed:false,endAllowed:false}),'end','neither on: the nearer, so the refusal names it')
 f.bot.findBlock=(orig=>o=>{f.log.push('find '+o.matching);return orig(o)})(f.bot.findBlock)
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,netherAllowed:true,endAllowed:false},{pollMs:5,crossMs:40,attempts:1,pauseMs:5}).catch(e=>e)
 assert.doesNotMatch(String(r?.message),/End is off/,'not refused for the End');assert.ok(!f.log.some(l=>/^step [3-5],30,/.test(l)),'never onto the end portal: '+f.log.join(' | '))
})

// The pathfinder never routes through a lit end portal: not into it from the
// floor beside the rim, not off the rim onto it.
test('no walk steps into or drops onto an end portal cell',()=>{
 const f=stronghold(),m=new DoorAwareMovements(f.bot),portal=n=>n.x>=3&&n.x<=5&&n.z>=-1&&n.z<=1&&n.y<=31
 for(const [x,y,z] of [[1,30,0],[2,31,0],[2,31,1],[4,31,-2]]){const moves=m.getNeighbors({x,y,z,remainingBlocks:0});assert.ok(!moves.some(portal),`from ${x},${y},${z}: `+JSON.stringify(moves.filter(portal)))}
 // A console-placed portal with no frame, on solid floor: only the avoid list stands between a walk and it.
 const bare=stronghold()
 for(const [k,n] of [...bare.worlds.overworld])if(n==='end_portal_frame')bare.worlds.overworld.delete(k);else if(n==='lava')bare.worlds.overworld.set(k,'stone_bricks')
 const walk=new DoorAwareMovements(bare.bot)
 for(const [x,y,z] of [[2,30,0],[2,30,1],[4,30,-2],[6,30,0]]){const moves=walk.getNeighbors({x,y,z,remainingBlocks:0});assert.ok(!moves.some(portal),`from ${x},${y},${z}: `+JSON.stringify(moves.filter(portal)))}
})

test('from the End the only way home is the exit fountain at 0,0, whatever the switch says',async()=>{
 const f=stronghold({fountain:true});f.bot.game.dimension='minecraft:the_end';f.bot.entity.position=new Vec3(4.5,61,.5)
 const r=await usePortal(f.bot,{kind:'use_portal',goal:{}},{...f.api,endAllowed:false},{pollMs:5})
 assert.equal(r.to.dimension,'overworld');assert.ok(Math.abs(r.from.portal.x)<=3&&Math.abs(r.from.portal.z)<=3)
 const g=stronghold();g.bot.game.dimension='minecraft:the_end';g.bot.entity.position=new Vec3(100.5,49,.5)
 g.worlds.the_end.set(key({x:110,y:48,z:0}),'end_portal')
 await assert.rejects(usePortal(g.bot,{kind:'use_portal',goal:{}},{...g.api,endAllowed:true},{pollMs:5}),/exit fountain/)
 assert.ok(!g.log.some(l=>/^(walk|step)/.test(l)))
})

// The controller's own check before it dispatches use_portal reads the same switches.
class PortalRunner extends EventEmitter{
 constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];const s=stronghold();this.bot={...s.bot,time:{timeOfDay:6000},findBlocks:()=>[]};this.bot.blockAt=s.bot.blockAt;this.bot.findBlock=s.bot.findBlock}
 position(){return {x:0,y:30,z:0}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
}
test('a planned use_portal beside an end portal follows the End switch, not the Nether one',async()=>{
 const r=new PortalRunner(),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'Going through.',steps:[{action:'use_portal',name:'',count:0,item:''}]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
 r.portalTravel=new PortalTravel(join(mkdtempSync(join(tmpdir(),'mc-end-travel-')),'portal-travel.json'));r.portalTravel.save({nether:'on'})
 await c.submit('go through the end portal')
 assert.ok(!r.commands.some(x=>x.action==='use_portal'));assert.ok(c.messages.some(m=>/travel to the End is off/.test(m.text)),JSON.stringify(c.messages.map(m=>m.text)))
 r.portalTravel.save({nether:'off',end:'on'})
 void c.submit('go through the end portal');await new Promise(res=>setTimeout(res,50))
 assert.ok(r.commands.some(x=>x.action==='use_portal'),JSON.stringify(r.commands))
})

test('the planner sees both switches, and the brief gates the End behind its own',async()=>{
 class Runner extends EventEmitter{constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot={players:{},inventory:{items:()=>[]}}}position(){return {x:0,y:64,z:0}}command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}}
 const r=new Runner();let observed
 const c=new Teammate(r,{model:'fake',plan:async(_,o)=>{observed=o;return {reply:'Noted.',steps:[]}}},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
 await c.submit('where can you go')
 assert.deepEqual(observed.portalTravel,{nether:'off',end:'off'})
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 const portals=brief.split('\n').find(l=>l.startsWith('PORTALS:'))
 assert.match(portals,/observation\.portalTravel\.end is "on"/)
 assert.match(portals,/toward 0,0/)
 assert.match(portals,/exit fountain/)
})

// lab/staging/watch.py stops a staged run on entering the End unless --allow-end says otherwise.
test('watch.py still stops on the End without --allow-end, and carries on with it',()=>{
 const staging=fileURLToPath(new URL('../lab/staging/',import.meta.url))
 const code=`import sys,json;sys.path.insert(0,${JSON.stringify(staging)});from watch_stops import dimension_stop as s
end={'dimension':'minecraft:the_end'};nether={'dimension':'the_nether'};portal={'dimension':'overworld','inPortal':True}
print(json.dumps([s(end),s(end,allow_nether=True),s(end,allow_end=True),s(nether),s(nether,allow_nether=True),s(portal),s(portal,allow_end=True),s({'dimension':'overworld'}),s({})]))`
 const p=spawnSync('python3',['-c',code],{encoding:'utf8'})
 assert.equal(p.status,0,p.stderr)
 assert.deepEqual(JSON.parse(p.stdout),['dimension_or_portal_stop','end_stop',null,'dimension_or_portal_stop',null,'dimension_or_portal_stop',null,null,null])
 const watch=readFileSync(new URL('../lab/staging/watch.py',import.meta.url),'utf8')
 assert.match(watch,/'--allow-end'/);assert.match(watch,/dimension_stop\(s,allow_nether=ALLOW_NETHER,allow_end=ALLOW_END\)/)
})
