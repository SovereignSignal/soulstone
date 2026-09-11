import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const runner=fileURLToPath(new URL('./run.js',import.meta.url))
const run=args=>spawnSync(process.execPath,[runner,...args],{encoding:'utf8',timeout:10000})
test('dry run needs no endpoint and marks every case not run',()=>{
 const r=run(['--dry-run']);assert.equal(r.status,0,r.stderr)
 const receipt=JSON.parse(r.stdout);assert.equal(receipt.results.length,8)
 assert(receipt.results.every(c=>c.status==='not-run'));assert.equal(receipt.inWorldSuccess,null)
})
test('actual evaluation requires an explicit profile',()=>{
 const r=run([]);assert.notEqual(r.status,0);assert.match(r.stderr,/Select an explicit profile/)
})
test('subscription is rejected without explicit opt in and profile stays unchanged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'minecraft-eval-test-'))
 try{
  const file=join(dir,'profiles.json'),source=JSON.stringify({active:'other',profiles:[{id:'candidate',kind:'codex',label:'Candidate',model:'gpt-6-astra'}]})
  writeFileSync(file,source)
  const r=run(['--profiles-file',file,'--profile','candidate'])
  assert.notEqual(r.status,0);assert.match(r.stderr,/requires --allow-subscription/)
  assert.equal(readFileSync(file,'utf8'),source)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('direct control runs without reaching an unavailable model endpoint',()=>{
 const r=run(['--endpoint','http://127.0.0.1:1/v1/chat/completions','--model','unavailable','--case','direct-rule-control'])
 assert.equal(r.status,0,r.stderr)
 const receipt=JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
 assert.equal(receipt.results[0].httpRequests,0)
 assert.equal(receipt.results[0].path,'direct-rule')
})
