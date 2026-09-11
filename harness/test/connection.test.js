import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Runner} from '../src/runner.js'

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'soul-reconnect-'))
  const runner=new Runner({host:'localhost',statePath:join(dir,'task.json')})
  let connections=0
  runner.connect=()=>{connections++}
  return {runner,count:()=>connections,cleanup:()=>{runner.close();rmSync(dir,{recursive:true,force:true})}}
}
test('explicit respawn is idempotent and leaves the failed task stopped',()=>{
 const {runner,cleanup}=fixture();let respawns=0
 runner.task={id:'mining',kind:'acquire',status:'paused',goal:{item:'diamond',count:1},deadline:Date.now()+60000}
 runner.bot={isAlive:false,health:0,respawn(){respawns++},clearControlStates(){},quit(){}}
 try{
  assert.equal(runner.respawn(),true);assert.equal(runner.respawn(),false);assert.equal(respawns,1);assert.equal(runner.task.status,'cancelled')
  runner.bot.isAlive=true;runner.bot.health=20;assert.throws(()=>runner.respawn(),/not dead/)
 }finally{cleanup()}
})

test('manual reconnect reopens exhausted retries once without replaying a task',()=>{
  const {runner,count,cleanup}=fixture()
  try {
    runner.task={id:'old-follow',kind:'follow',status:'running',goal:{player:'Player'},deadline:Date.now()+60000}
    runner.attempts=5;runner.retry()
    assert.equal(runner.closed,true)
    assert.equal(runner.task.status,'failed')
    assert.equal(runner.reconnect(),true)
    assert.equal(count(),1)
    assert.equal(runner.closed,false)
    assert.equal(runner.attempts,0)
    assert.equal(runner.task.status,'failed')
    assert.equal(runner.reconnect(),false)
    assert.equal(count(),1)
  } finally {cleanup()}
})

test('manual reconnect leaves healthy sessions, pending attempts and intentional shutdown alone',()=>{
  const {runner,count,cleanup}=fixture()
  try {
    runner.ready=true
    assert.equal(runner.reconnect(),false)
    runner.ready=false
    assert.equal(runner.reconnect(),false)
    runner.close()
    assert.equal(runner.reconnect(),false)
    assert.equal(count(),0)
  } finally {cleanup()}
})
