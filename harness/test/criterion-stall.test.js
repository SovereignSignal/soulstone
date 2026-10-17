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
  // Was: 'a new high of an existing item is progress'. Trial 6 mined 253
  // cobblestone after its goal was in hand and the guard never fired, because
  // every dig raised a high. Only a NEW kind of item, or more of an item the
  // criteria name, counts now.
  request.rounds=10;noteCriterionStall(request,{cobblestone:6,raw_iron:1})
  assert.equal(criterionStall(request).rounds,3,'more of an item the goal does not name is not progress')
  request.rounds=11;noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,4,'no inventory supplied leaves the highs alone')
  request.rounds=12;noteCriterionStall(request,{cobblestone:6,raw_iron:1,coal:1})
  assert.equal(criterionStall(request).rounds,0,'a first coal is progress')
  // An item the criteria name counts by count, not just by first appearance.
  const named={rounds:1,verification:verdict([check({item:'raw_iron',count:3,observed:0})]),mission:mission()}
  noteCriterionStall(named,{raw_iron:1});named.rounds=2;noteCriterionStall(named,{raw_iron:1})
  assert.equal(criterionStall(named).rounds,1)
  named.rounds=3;noteCriterionStall(named,{raw_iron:2})
  assert.equal(criterionStall(named).rounds,0,'a second raw iron toward a raw_iron criterion is progress')
})

test('a distance criterion keys on passed alone, so walking does not reset the stall',()=>{
  const near=o=>verdict([check({kind:'at_owner',item:'',observed:o,passed:false})])
  assert.equal(criterionFingerprint(near(7.31415),mission()),criterionFingerprint(near(5.02718),mission()))
  assert.notEqual(criterionFingerprint(near(7.3),mission()),criterionFingerprint(verdict([check({kind:'at_owner',item:'',observed:1.2,passed:true})]),mission()))
})

// A construct that places 64 blocks a round with materials already carried
// changes no check, node or inventory high until it finishes; twenty such
// rounds on a big build would halt it while it was visibly working.
test('a rising verified block count on a saved project resets the criterion stall; a flat one does not',()=>{
  const request={rounds:1,verification:verdict(),mission:mission()}
  const projects=n=>({tower:{construction:true,result:{partial:true,verifiedBlocks:n,totalBlocks:2000}}})
  noteCriterionStall(request,{cobblestone:900},projects(64))
  for(let r=2;r<=5;r++){request.rounds=r;noteCriterionStall(request,{cobblestone:900},projects(64*r))}
  assert.equal(criterionStall(request).rounds,0,'every round laid more verified blocks')
  request.rounds=6;noteCriterionStall(request,{cobblestone:900},projects(320))
  assert.equal(criterionStall(request).rounds,1,'the same count again is not progress')
  request.rounds=7;noteCriterionStall(request,{cobblestone:900},projects(100))
  assert.equal(criterionStall(request).rounds,2,'a lower count does not lower the high-water mark')
})

test('verified blocks reported in construct feedback count even without a projects argument',()=>{
  const request={rounds:1,verification:verdict(),mission:mission(),feedback:[]}
  const round=n=>request.feedback.push({action:'construct',step:{action:'construct',name:'tower'},status:'completed',result:{project:'tower',partial:true,verifiedBlocks:n}})
  round(64);noteCriterionStall(request)
  request.rounds=2;round(128);noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,0)
  request.rounds=3;noteCriterionStall(request)
  assert.equal(criterionStall(request).rounds,1)
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
    this.profile='lab';this.owner='Player';this.ready=true;this.commands=[];this.pos={x:0,y:64,z:0}
    this.bot={players:{Player:{entity:{position:{x:1,y:64,z:2}}}},inventory:{items:()=>[]}}
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


test('saved construction materials count as bounded progress toward the requested project',()=>{
 const request={rounds:1,verification:verdict([check({kind:'construction',item:'',target:'portal'})]),mission:mission()}
 const projects={portal:{construction:{},result:{missingMaterials:{obsidian:10,cobblestone:32}}},other:{construction:{},result:{missingMaterials:{dirt:100}}}}
 noteCriterionStall(request,{obsidian:9,cobblestone:32,dirt:1},projects)
 request.rounds=2;noteCriterionStall(request,{obsidian:9,cobblestone:32,dirt:1},projects)
 assert.equal(criterionStall(request).rounds,1)
 request.rounds=3;noteCriterionStall(request,{obsidian:10,cobblestone:32,dirt:1},projects)
 assert.equal(criterionStall(request).rounds,0,'tenth required obsidian is progress')
 request.rounds=4;noteCriterionStall(request,{obsidian:11,cobblestone:33,dirt:2},projects)
 assert.equal(criterionStall(request).rounds,1,'surplus and unrelated project materials do not count')
 request.rounds=5;noteCriterionStall(request,{obsidian:9,cobblestone:32,dirt:1},projects)
 request.rounds=6;noteCriterionStall(request,{obsidian:10,cobblestone:32,dirt:1},projects)
 assert.equal(criterionStall(request).rounds,3,'spending and recovering cannot reset the guard')
 request.rounds=7;noteCriterionStall(request,{obsidian:10,cobblestone:32,dirt:1})
 assert.equal(criterionStall(request).rounds,4,'omitted project snapshot preserves progress history')
})
