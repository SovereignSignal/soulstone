import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  CRITERION_STALL_ROUNDS,
  criterionFingerprint,
  criterionStall,
  noteCriterionStall,
} from '../src/companion/continuity.js'
import {Teammate} from '../src/companion/controller.js'

const check=(over={})=>({kind:'inventory',item:'diamond',target:'',passed:false,observed:0,...over})
const verdict=(checks=[check()],missing=['Carry 1 diamond'])=>({verdict:'needs_work',checks,missing})
const mission=(nodes=[{id:'mine',status:'ready'}])=>({nodes})

test('criterion fingerprint ignores surrounding floats and feedback, keys on check results',()=>{
  const a=verdict([check({observed:0})])
  const b=verdict([check({observed:0})])
  // Same check results; callers may also carry raw position floats or feedback
  // that must not affect the fingerprint.
  assert.equal(criterionFingerprint(a,mission()),criterionFingerprint(b,mission()))
  assert.equal(
    criterionFingerprint(a,mission()),
    criterionFingerprint({...a,feedback:[{action:'travel',status:'completed'}],position:{x:1.0001,y:64.9,z:-2.3}},mission()),
  )
})

test('criterion fingerprint changes when a check flips or a mission node status changes',()=>{
  const base=criterionFingerprint(verdict([check({passed:false})]),mission([{id:'mine',status:'ready'}]))
  assert.notEqual(base,criterionFingerprint(verdict([check({passed:true,observed:1})]),mission([{id:'mine',status:'ready'}])))
  assert.notEqual(base,criterionFingerprint(verdict([check({passed:false})]),mission([{id:'mine',status:'verified'}])))
})

test('criterion stall counter increments on a stable fingerprint and resets on change',()=>{
  const request={rounds:1,verification:verdict(),mission:mission()}
  noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,0)
  assert.equal(request.criterionStallSince,1)
  request.rounds=2;noteCriterionStall(request)
  request.rounds=3;noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,2)
  request.verification=verdict([check({passed:true,observed:1})])
  request.rounds=4;noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,0)
  assert.equal(request.criterionStallSince,4)
})

// Trial 2, 2026-09-23: the agent mined its first raw iron, coal and 28
// cobblestone across 20 rounds and the guard halted it, because none of those
// is a goal criterion. Acquiring something new is progress; walking is not.
test('a new inventory high resets the criterion stall; moving, spending and re-gaining do not',()=>{
  const request={rounds:1,verification:verdict(),mission:mission()}
  noteCriterionStall(request,{cobblestone:5})
  for(let r=2;r<=6;r++){request.rounds=r;noteCriterionStall(request,{cobblestone:5})}
  assert.equal(criterionStall(request).rounds,5)
  request.rounds=7;noteCriterionStall(request,{cobblestone:5,raw_iron:1})
  assert.equal(criterionStall(request).rounds,0,'first raw iron is progress')
  assert.equal(request.criterionStallSince,7)
  request.rounds=8;noteCriterionStall(request,{cobblestone:2,raw_iron:1})
  assert.equal(criterionStall(request).rounds,1,'spending cobblestone is not progress')
  request.rounds=9;noteCriterionStall(request,{cobblestone:5,raw_iron:1})
  assert.equal(criterionStall(request).rounds,2,'regaining a count already reached is not progress')
  request.rounds=10;noteCriterionStall(request,{cobblestone:6,raw_iron:1})
  assert.equal(criterionStall(request).rounds,0,'a new high of an existing item is progress')
  request.rounds=11;noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,1,'no inventory supplied leaves the highs alone')
})

test('criterion stall reports true at exactly CRITERION_STALL_ROUNDS and false one below',()=>{
  const request={rounds:0,verification:verdict(),mission:mission()}
  // Seed through the function rather than by writing its private fields.
  noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,0)
  for(let i=0;i<CRITERION_STALL_ROUNDS-1;i++){
    request.rounds=i+1
    noteCriterionStall(request)
  }
  assert.equal(criterionStall(request).rounds,CRITERION_STALL_ROUNDS-1)
  assert.equal(criterionStall(request).stalled,false)
  request.rounds=CRITERION_STALL_ROUNDS
  noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,CRITERION_STALL_ROUNDS)
  assert.equal(criterionStall(request).stalled,true)
})

class FakeRunner extends EventEmitter {
  constructor(){
    super()
    this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.pos={x:0,y:64,z:0}
    this.bot={players:{Sov:{entity:{position:{x:1,y:64,z:2}}}},inventory:{items:()=>[]}}
  }
  position(){return {...this.pos}}
  command(c){
    this.emit('operator_command',c);this.commands.push(c)
    if(c.action==='stop'||c.action==='follow')return
    // Move each completed step so progressFingerprint refreshes and the
    // three-round stagnation stop does not fire before the criterion stall.
    this.pos={x:this.pos.x+1,y:64,z:0}
    this.task={id:String(this.commands.length),status:'completed',result:{moved:this.pos.x}}
    queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))
  }
}

test('a looping planner with no criterion change is blocked after CRITERION_STALL_ROUNDS and not before',async()=>{
  let calls=0,sawBelow=false
  const r=new FakeRunner()
  const c=new Teammate(r,{
    model:'fake',
    formulate:async()=>({kind:'task',summary:'Mine a diamond.',projectMode:'none',criteria:[{kind:'inventory',item:'diamond',count:1,target:'',description:'Carry 1 diamond'}],milestones:[],constraints:[]}),
    plan:async()=>{
      calls++
      if(calls===CRITERION_STALL_ROUNDS-1){
        assert.equal(c.requestProgress.status,'running')
        assert.ok((c.requestProgress.criterionStallRounds||0)<CRITERION_STALL_ROUNDS)
        sawBelow=true
      }
      return {reply:'Prospecting.',steps:[{action:'acquire',item:'cobblestone',count:1}]}
    },
  },join(mkdtempSync(join(tmpdir(),'mc-criterion-stall-')),'state.json'))
  await c.submit('get a diamond')
  assert.equal(sawBelow,true,'the request was still running one round before the stall threshold')
  assert.equal(c.requestProgress.status,'blocked')
  // reviewRequired carries the review message, as everywhere else in the
  // controller (interruptedEffect); a truthy string is what blocks stallRetry.
  assert.match(String(c.requestProgress.reviewRequired),/No goal criterion has changed/)
  assert.match(c.requestProgress.blocker,/No goal criterion has changed in \d+ planning rounds \(last change at round \d+\)\. Halting rather than looping\. Remaining: Carry 1 diamond/)
  assert.match(c.messages.at(-1).text,/No goal criterion has changed/)
  assert.ok(calls<CRITERION_STALL_ROUNDS+2,`planner should stop near the threshold, got ${calls} calls`)
})
