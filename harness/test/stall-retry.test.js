import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Teammate} from '../src/companion/controller.js'
import {STALL_RETRY_MS} from '../src/companion/continuity.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'

// Live rehearsal R9, 17 October 06:17:41Z (design of the blaze endgame, round two, section 3): walled in at the spawner, the
// covered phase had dispatched the blaze stand, which sat shut and waiting. Ninety seconds after the hut went up the stall
// retry saw the request blocked with nothing wrong on that tick ("Blocked and nothing else is wrong, so I am trying again
// (1 of 3)") and resumed it: the resume cancelled the covered phase, nulled the held shelter and left the stand running,
// orphaned, until the next alarm stopped it as an operator stop. A held shelter is the shelter's to end, never a stall.
class FakeRunner extends EventEmitter{
 constructor(){super();this.profile='lab';this.owner='Player';this.ready=true;this.commands=[];this.bot={players:{},inventory:{items:()=>[]}}}
 position(){return {x:-36,y:60,z:-9}}
 command(c){this.emit('operator_command',c);this.commands.push(c)}
}
test('ninety seconds blocked inside a held shelter with a covered stand running is not a stall: stallRetry returns false, safety and the task are untouched',async()=>{
 const r=new FakeRunner(),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stall-')),'state.json'))
 let resumes=0;c.resume=async()=>{resumes++;c.cancel(false);c.safety=null}
 c.phase='blocked';c.blockedSince=Date.now()-STALL_RETRY_MS-1000
 c.requestProgress={id:'r9',request:'blaze rods',status:'interrupted',blocker:'A potential hostile is within ten blocks'}
 const safety=c.safety={status:'sheltered',reason:THREAT_INTERRUPTION,retreat:{shelterName:'hut',surface:{x:-36,y:60,z:-9}},covered:{from:{x:-36,y:60,z:-9},at:{x:-36,y:60,z:-9},moves:[]}}
 const task=r.task={id:'7',kind:'stand',status:'running',goal:{item:'blaze_rod',count:4}}
 assert.equal(await c.stallRetry(),false)
 assert.equal(resumes,0,'no resume');assert.equal(c.safety,safety,'the shelter is still held');assert.equal(r.task,task);assert.equal(task.status,'running')
 assert.ok(!r.commands.some(x=>x.action==='stop'),'nothing stopped');assert.ok(!c.messages.some(m=>/trying again/.test(m.text)),'nothing said')
 // The covered phase deciding or waiting between moves, nothing running: still the shelter at work.
 task.status='completed';c.coveredSafety=safety
 assert.equal(await c.stallRetry(),false);assert.equal(resumes,0);assert.equal(c.safety,safety)
 // Nothing running and no phase: the hold's own rules decide, as before (a watch that gave up leaves the retry in charge).
 c.coveredSafety=null;safety.continuation={status:'paused',code:'clearance_timeout'}
 assert.equal(await c.stallRetry(),true);assert.equal(resumes,1)
})
