import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {projectFootprints} from '../src/site-survey.js'
import {insideBase,inspectRetreatShelter} from '../src/retreat.js'
import {projectDimension,sameDimension,inEnd} from '../src/dimension.js'
import {Teammate,relocateWay,centreward} from '../src/companion/controller.js'
import {roofed} from '../src/observations.js'
import {emergencyReason,NIGHT_EXPOSURE} from '../src/survival.js'

// The Nether plan, step 2: saved state carries the
// dimension it was made in, and missing means the Overworld, so nothing saved
// before today changes. In the Nether the Overworld base is not home.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
const base={build:{origin:{x:10,y:64,z:20},design},stations:{torch:{position:{x:11,y:64,z:22},confirmed:true}}}
const bot=(dimension,at=[11.5,64,21.5])=>({game:{dimension:`minecraft:${dimension}`},entity:{position:new Vec3(...at)}})

test('a saved thing without a dimension is in the Overworld',()=>{
 assert.equal(projectDimension(base),'overworld');assert.equal(projectDimension({...base,dimension:'the_nether'}),'the_nether')
 assert.equal(sameDimension(bot('overworld'),base),true);assert.equal(sameDimension(bot('the_nether'),base),false)
 assert.equal(sameDimension({game:{}},base),true,'an unknown dimension is not evidence of another one')
})

test('footprints protect only the builds in the dimension asked for; unasked, all of them',()=>{
 const projects={base,frame:{construction:{origin:{x:0,y:70,z:0},design:[{x:0,y:0,z:0,block:'obsidian'}]},dimension:'the_nether'}}
 assert.equal(projectFootprints(projects,'overworld').some(s=>s.minX===0&&s.maxX===0),false,'the Nether frame does not protect Overworld ground')
 assert.ok(projectFootprints(projects,'overworld').some(s=>s.minX===10),'the Overworld base does')
 assert.equal(projectFootprints(projects,'the_nether').some(s=>s.minX===10),false,'and not Nether ground')
 assert.equal(projectFootprints(projects).length,projectFootprints(projects,'overworld').length+projectFootprints(projects,'the_nether').length)
})

test('in the Nether the bot is never inside its Overworld base, and the base is no shelter',()=>{
 assert.equal(insideBase(bot('overworld'),base),true)
 assert.equal(insideBase(bot('the_nether'),base),false,'the same x and z in the Nether is somewhere else')
 assert.throws(()=>inspectRetreatShelter(bot('the_nether'),base),/base is in the overworld/)
})

class Runner extends EventEmitter{constructor(){super();this.profile='lab';this.owner='Player';this.ready=true;this.commands=[];this.bot={game:{dimension:'minecraft:the_nether'},players:{},inventory:{items:()=>[]}}}position(){return {x:1,y:70,z:2}}command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}}
const teammate=()=>{const r=new Runner();return [r,new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-dimension-')),'state.json'))]}

test('a shelter built in the Nether does not replace the Overworld base; a construction there is stamped with it',()=>{
 const [r,c]=teammate();c.projects.base=structuredClone({...base,built:true})
 r.emit('event',{type:'task_finished',task:{id:'b',kind:'build',status:'completed',goal:{design,origin:{x:0,y:70,z:0},wood:'oak_log',purpose:'shelter'}}})
 assert.deepEqual(c.projects.base.build.origin,{x:10,y:64,z:20})
 r.emit('event',{type:'task_finished',task:{id:'k',kind:'construct',status:'completed',goal:{name:'way_home',design:[{x:0,y:0,z:0,block:'cobblestone'}],origin:{x:0,y:70,z:0}}}})
 assert.equal(c.projects.way_home.dimension,'the_nether')
 r.emit('event',{type:'death'})
 assert.equal(c.lastDeath.dimension,'the_nether')
})

// The dragon roadmap, brief 3: the End has no day and no
// night, and every edge of its island is the void.
test('the End is a dimension of its own, and its clock means nothing',()=>{
 assert.equal(inEnd(bot('the_end')),true);assert.equal(inEnd(bot('the_nether')),false);assert.equal(inEnd({game:{}}),false)
 const open=dimension=>({...bot(dimension,[100.5,49,.5]),blockAt:()=>({name:'air',boundingBox:'empty'})})
 assert.equal(roofed(open('the_end')),true,'no sky to wait under');assert.equal(roofed(open('overworld')),false)
 const night={gameMode:'survival',health:20,food:20,difficulty:'normal',headSubmerged:false,oxygen:20,nearbyThreats:[],carriedFood:[],timeOfDay:15000,shelterAvailable:false}
 assert.equal(emergencyReason({...night,dimension:'overworld'}),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...night,dimension:'the_end'}),null,'night exposure is not raised in the End')
 assert.equal(emergencyReason({...night,dimension:'the_end',idle:true,shelterAvailable:true,openSky:true}),null)
})

test('in the End a shelter that will not clear moves toward the centre, never outward',()=>{
 assert.equal(relocateWay(bot('the_end',[100.5,49,.5])),'centre')
 assert.equal(relocateWay(bot('overworld')),'flee')
 for(const at of [[60.5,61,.5],[-30.5,61,40.5],[12.5,61,-70.5],[9.5,61,9.5]]){const b=island(at),to=centreward(b);assert.ok(to&&Math.hypot(to.x,to.z)<Math.hypot(at[0],at[2]),JSON.stringify([at,to]))}
 assert.equal(centreward(island([3.5,61,2.5])),null,'beside the fountain already: nowhere further in to go')
})

// Review of brief 3: the step toward 0,0 kept the bot's height and ignored the
// ground, so from an outer island it pointed across the void. It moves only on
// the main island, and only to a cell with ground under it.
const MAIN=new Set(['end_stone'])
function island(at,{hole=()=>false,ground=60}={}){
 const name=p=>hole(p)?'air':p.y<=ground&&Math.abs(p.x)<90&&Math.abs(p.z)<90||p.y<=ground&&Math.abs(p.x-1000)<20&&Math.abs(p.z)<20?'end_stone':'air'
 return {...bot('the_end',at),registry:minecraftData('1.21.4'),blockAt:p=>({name:name(p),position:p,boundingBox:MAIN.has(name(p))?'block':'empty'})}
}
test('in the End the move toward the centre lands on ground, and never leaves an outer island',()=>{
 const to=centreward(island([60.5,61,.5]))
 assert.deepEqual(to,{x:29,y:61,z:0},'a full step onto end stone')
 assert.deepEqual(centreward(island([60.5,61,.5],{hole:p=>p.x<50&&p.y>57})),{x:29,y:58,z:0},'ground a few blocks lower is still ground')
 const gap=island([60.5,61,.5],{hole:p=>p.x>=20&&p.x<=36})
 const short=centreward(gap)
 assert.ok(short&&short.x>36&&short.x<60,'a shorter step when the full one ends over the void: '+JSON.stringify(short))
 assert.equal(gap.blockAt(new Vec3(short.x,short.y-1,short.z)).name,'end_stone')
 assert.equal(centreward(island([1000.5,61,.5])),null,'an outer island holds where it is: inward from there is the void')
 assert.equal(centreward(island([85.5,61,.5])),null,'past the main island\'s middle, it holds')
})
