import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {projectFootprints} from '../src/site-survey.js'
import {insideBase,inspectRetreatShelter} from '../src/retreat.js'
import {projectDimension,sameDimension} from '../src/dimension.js'
import {Teammate} from '../src/companion/controller.js'

// workstreams/minecraft/nether-plan.md, step 2: saved state carries the
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

class Runner extends EventEmitter{constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot={game:{dimension:'minecraft:the_nether'},players:{},inventory:{items:()=>[]}}}position(){return {x:1,y:70,z:2}}command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}}
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
