import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {roofed} from '../src/observations.js'
import {sleepThroughNight} from '../src/sleep.js'
import {makeObsidian} from '../src/obsidian.js'
import {Teammate} from '../src/companion/controller.js'

// workstreams/minecraft/nether-plan.md, step 3. The Nether has a bedrock
// ceiling and no sky, and mineflayer still reports the shared world clock, so
// the night rules must stand down there: they already do under rock.
const bot=dimension=>({game:{dimension:`minecraft:${dimension}`,gameMode:'survival',difficulty:'normal'},time:{timeOfDay:14000},health:20,food:20,entities:{},players:{},
 entity:{position:new Vec3(0.5,70,0.5),onGround:true},inventory:{items:()=>[{name:'diamond_pickaxe',count:1},{name:'water_bucket',count:1}]},
 blockAt:p=>({name:p.y===69?'netherrack':'air',position:p.clone(),boundingBox:p.y===69?'block':'empty'})})

test('the Nether counts as under rock: an open cavern there is roofed',()=>{
 assert.equal(roofed(bot('the_nether')),true)
 assert.equal(roofed(bot('overworld')),false,'the same open air in the Overworld is the sky')
})

test('outside the Overworld a bed is refused, and in the Nether so is making obsidian',async()=>{
 await assert.rejects(sleepThroughNight(bot('the_nether'),{kind:'sleep',goal:{}},{check(){},stage(){},progress(){}}),/explode/)
 const noop=async()=>{}
 await assert.rejects(makeObsidian(bot('the_nether'),{kind:'make_obsidian',goal:{count:1}},{check(){},progress(){},stage(){},walk:noop,settle:noop,mine:noop,fill:noop,count:()=>0,persist(){}}),/evaporates/)
})

test('in the Nether the daylight walk onto open ground is skipped',async()=>{
 class Runner extends EventEmitter{constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot=bot('the_nether');this.bot.time.timeOfDay=6000}position(){return {x:0,y:70,z:0}}command(c){this.commands.push(c)}}
 const r=new Runner(),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-nether-')),'state.json'))
 assert.equal(await c.leaveOnOpenGround(c.epoch,new AbortController().signal,r.bot,false),'skipped')
 assert.deepEqual(r.commands,[])
})
