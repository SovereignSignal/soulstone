import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/);const run=promisify(execFile)
const rcon=async field=>(await run('ssh',['-o','BatchMode=yes',host,`sudo docker exec mc-sandbox rcon-cli 'data get entity HarnessRunner ${field}'`],{timeout:15000})).stdout.trim()
const state=async()=>{const a=JSON.parse(readFileSync('state/companion-api.json'));return (await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token},signal:AbortSignal.timeout(8000)})).json()}
const initial=await state(),id=initial.requestProgress.id,out={status:'waiting',requestId:id}
try{
 for(let n=0;n<240;n++){
  const s=await state();assert.equal(s.requestProgress.id,id);assert.equal(s.survival.difficulty,'easy','Easy window ended before return reading')
  if(s.task?.kind==='retreat'&&s.task.status==='completed'&&s.task.result?.receipt==='sheltered_door_closed'){
   out.at=Date.now();for(const f of ['foodLevel','foodSaturationLevel','foodExhaustionLevel'])out[f]=await rcon(f)
   assert.equal((await state()).survival.difficulty,'easy','Restoration overlapped food reading');out.status='captured';break
  }
  await delay(5000)
 }
 assert.equal(out.status,'captured','No return reading within 20 minutes')
}catch(e){out.status='unavailable';out.reason=e.message}
writeFileSync(process.env.MC_FOOD_REPORT||'results/easy-work-food-return.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out))
