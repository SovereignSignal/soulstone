import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Runner,SLOW_RETRY_MS} from '../src/runner.js'

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

test('a server the bot has played on is retried once a minute without end; one never joined still gives up',()=>{
  // 3 October 2026, 03:42 PDT: the family server restarted, five tries failed
  // in under a minute, connection_exhausted, and the bot stayed out four hours.
  const {runner,cleanup}=fixture()
  try {
    const events=[];runner.on('event',e=>events.push(e))
    runner.everJoined=true;runner.task={id:'t',kind:'follow',status:'running',goal:{player:'Player'},deadline:Date.now()+60000}
    runner.attempts=5;runner.retry()
    assert.equal(runner.closed,false);assert.ok(!runner.connectionExhausted);assert.equal(runner.task.status,'failed')
    assert.deepEqual(events.filter(e=>e.type==='reconnecting').map(e=>[e.delayMs,e.slow]),[[SLOW_RETRY_MS,true]])
    clearTimeout(runner.retryTimer);runner.retry();runner.retry()
    assert.equal(runner.closed,false,'it never gives up');assert.equal(events.filter(e=>e.type==='connection_exhausted').length,0)
    clearTimeout(runner.retryTimer)
  } finally {cleanup()}
  const fresh=fixture()
  try { fresh.runner.attempts=5;fresh.runner.retry();assert.equal(fresh.runner.closed,true);assert.equal(fresh.runner.connectionExhausted,true) } finally {fresh.cleanup()}
})

// 16 October: the Pi rebooted at 19:16, the agent started before the server's seventy second
// startup, five tries failed in thirty seconds, and the bot stayed out seven and a half hours.
// The join is kept beside the task state, so a fresh process knows this server is down, not wrong.
test('a runner whose saved state says it joined this server keeps retrying once a minute after a restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'soul-rejoin-')),statePath=join(dir,'task.json'),worldId='00000000-0000-4000-8000-000000000001'
  const runners=[],make=host=>{const r=new Runner({host,worldId,statePath});r.connect=()=>{};runners.push(r);return r}
  const knock=(r,n)=>{for(let i=0;i<n;i++){r.retry();clearTimeout(r.retryTimer)}}
  try {
    const before=make('localhost');before.joined();before.close()
    const after=make('localhost'),events=[];after.on('event',e=>events.push(e))
    knock(after,8)
    assert.equal(after.closed,false,'it never gives up');assert.ok(!after.connectionExhausted)
    assert.deepEqual(events.filter(e=>e.type==='reconnecting').slice(5).map(e=>[e.delayMs,e.slow]),[[SLOW_RETRY_MS,true],[SLOW_RETRY_MS,true],[SLOW_RETRY_MS,true]])
    assert.equal(events.filter(e=>e.type==='connection_exhausted').length,0)
    after.close()
    // The same world set up with another address has never joined there: it gives up as before.
    const moved=make('otherhost');knock(moved,6);assert.equal(moved.connectionExhausted,true)
  } finally {for(const r of runners)r.close();rmSync(dir,{recursive:true,force:true})}
})
test('a fresh runner, or state saved before any join, still exhausts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'soul-rejoin-')),statePath=join(dir,'task.json')
  try {
    const fresh=new Runner({host:'localhost',statePath});fresh.connect=()=>{}
    for(let i=0;i<6;i++){fresh.retry();clearTimeout(fresh.retryTimer)}
    assert.equal(fresh.connectionExhausted,true);fresh.close()
    const again=new Runner({host:'localhost',statePath});again.connect=()=>{}
    for(let i=0;i<6;i++){again.retry();clearTimeout(again.retryTimer)}
    assert.equal(again.connectionExhausted,true,'a restart alone proves nothing');again.close()
  } finally {rmSync(dir,{recursive:true,force:true})}
})

// Run 69, 8 October: the test bot died, the agent restarted for a deploy, and
// on every rejoin the server logged it in dead. A dead player gets the death
// screen, not a spawn, so the 30 second join timer ended each connection and
// five rejoins later the runner gave up. Dying at login is a completed join.
test('a bot that logs in dead keeps its connection, so it can be respawned',async()=>{
 const {runner,cleanup}=fixture();let ended=false
 const bot={isAlive:false,health:0,end(){ended=true},clearControlStates(){},quit(){}}
 runner.bot=bot;runner.joinTimer=setTimeout(()=>bot.end('join timeout'),40)
 try{
  runner.onDeath(bot)
  await new Promise(res=>setTimeout(res,80))
  assert.equal(ended,false,'the join timer no longer ends a dead login');assert.equal(runner.ready,false)
 }finally{cleanup()}
})
