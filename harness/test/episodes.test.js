import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { EpisodeRecorder } from '../src/companion/episodes.js'
import { LocalPlanner } from '../src/companion/planner.js'
import { Teammate } from '../src/companion/controller.js'
const directory=()=>mkdtempSync(join(tmpdir(),'mc-episodes-'))
const readEpisode=dir=>readFileSync(join(dir,readdirSync(dir)[0]),'utf8').trim().split('\n').map(JSON.parse)
test('episode end is terminal and never labels a model claim as training success',()=>{
 const dir=directory(),episode=new EpisodeRecorder(dir).start({request:'build',model:'fake'})
 episode.write('decision',{output:'done'});episode.end('model_finished');episode.end('cancelled');episode.write('decision',{output:'late'})
 const events=readEpisode(dir)
 assert.deepEqual(events.map(e=>e.type),['start','decision','end']);assert.equal(events.at(-1).trainingEligible,false)
 assert.equal(statSync(join(dir,readdirSync(dir)[0])).mode&0o777,0o600)
})
test('recording failure reports once without breaking gameplay',()=>{
 const path=join(directory(),'file');writeFileSync(path,'occupied');const errors=[]
 const episode=new EpisodeRecorder(path,message=>errors.push(message)).start({});episode.write('plan',{});episode.end('blocked');assert.equal(errors.length,1)
})
test('planner recording distinguishes model repair from deterministic routing and omits keys',async()=>{
 const planner=new LocalPlanner(),events=[];let calls=0
 planner.profiles={current:{id:'test',kind:'local',model:'fake',url:planner.url,maxTokens:900},key:'secret-test-token'}
 planner.fetcher=async()=>({ok:true,json:async()=>({choices:[{message:{content:++calls===1?'invalid':JSON.stringify({reply:'Inspect first.',steps:[{action:'inspect'}]})}}]})})
 const plan=await planner.plan('Prepare a workshop.',{feedback:[]},[],new AbortController().signal,'',e=>events.push(e))
 assert.equal(plan.steps[0].action,'inspect');assert.equal(events.length,2);assert.ok(events[0].error);assert.equal(events[1].repair,true)
 assert.equal(JSON.stringify(events).includes('secret-test-token'),false)
 await planner.plan('chop wood',{inventory:{}},[],new AbortController().signal,'',e=>events.push(e))
 assert.equal(events.at(-1).route,'direct');assert.equal(calls,2)
})
class Runner extends EventEmitter {
 constructor(){super();this.profile='fixture';this.owner='Owner';this.ready=true;this.bot={players:{},inventory:{items:()=>[]}};this.commands=[]}
 position(){return {x:0,y:64,z:0}}
 command(command){this.commands.push(command)}
}
test('cancelled inference records cancellation and discards its late plan',async()=>{
 const dir=directory(),runner=new Runner();let respond
 const planner={model:'fake',plan:()=>new Promise(resolve=>respond=resolve)}
 const controller=new Teammate(runner,planner,join(directory(),'state.json'),new EpisodeRecorder(dir))
 const pending=controller.submit('build a workshop');controller.stop();respond({reply:'On it',steps:[{action:'inspect'}]});await pending
 const events=readEpisode(dir);assert.equal(events.at(-1).status,'cancelled');assert.equal(events.some(e=>e.type==='plan'),false)
})
test('model ending a request is recorded as a claim, not verified completion',async()=>{
 const dir=directory(),runner=new Runner()
 const controller=new Teammate(runner,{model:'fake',plan:async()=>({reply:'Done',steps:[]})},join(directory(),'state.json'),new EpisodeRecorder(dir))
 await controller.submit('make a workshop');const events=readEpisode(dir)
 assert.equal(events.at(-1).status,'model_finished');assert.equal(events.at(-1).trainingEligible,false)
 controller.stop();assert.equal(readEpisode(dir).at(-1).status,'model_finished')
})

test('failed actions and revised observations retain outcomes without becoming positive examples',async()=>{
 const dir=directory(),runner=new Runner();let calls=0
 runner.command=function(command){
  this.task={id:'attempt-'+(++calls),status:'running'}
  if(command.action==='acquire'){
   const task={...this.task,status:'failed',reason:'No reachable stone'}
   queueMicrotask(()=>this.emit('event',{type:'task_finished',task}))
  }
 }
 const planner={model:'fake',plan:async()=>({reply:'Trying.',steps:[{action:'acquire',item:'stone_pickaxe',count:1}]})}
 const controller=new Teammate(runner,planner,join(directory(),'state.json'),new EpisodeRecorder(dir))
 await controller.submit('make a stone pickaxe')
 const events=readEpisode(dir),outcomes=events.filter(e=>e.type==='action_result')
 assert.equal(outcomes.length,2);assert.ok(outcomes.every(e=>e.outcome.status==='failed'))
 assert.equal(events.filter(e=>e.type==='observation')[1].observation.feedback[0].reason,'No reachable stone')
 assert.equal(events.at(-1).status,'blocked');assert.equal(events.at(-1).trainingEligible,false)
})
