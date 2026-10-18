import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {LocalPlanner,validatePlan} from '../src/companion/planner.js'
import {validateProfile} from '../src/companion/providers.js'
import {directPlan} from '../src/companion/direct-plan.js'
import {cases} from './cases.js'
import {scorePlan} from './score.js'
const {values:args}=parseArgs({options:{'dry-run':{type:'boolean'},'profiles-file':{type:'string'},profile:{type:'string'},endpoint:{type:'string'},model:{type:'string'},'max-tokens':{type:'string',default:'4096'},'allow-subscription':{type:'boolean'},case:{type:'string',multiple:true},out:{type:'string'},help:{type:'boolean'}}})
if(args.help){console.log('node eval/run.js --dry-run | --endpoint http://127.0.0.1:PORT/v1/chat/completions --model MODEL | --profiles-file FILE --profile ID [--allow-subscription]\nOptional: --case ID (repeatable), --max-tokens 4096, --out FILE. No profile is activated or saved. Cloud API profiles are disabled.');process.exit(0)}
if((args['profiles-file']||args.profile)&&(args.endpoint||args.model))throw new Error('Choose a profile file or an endpoint/model pair, not both')
let profile
if(args['profiles-file']||args.profile){
  if(!args['profiles-file']||!args.profile)throw new Error('Both --profiles-file and --profile are required')
  const file=JSON.parse(readFileSync(args['profiles-file'],'utf8'))
  profile=validateProfile(file.profiles?.find(p=>p.id===args.profile))
}else if(args.endpoint||args.model){
  if(!args.endpoint||!args.model)throw new Error('Both --endpoint and --model are required')
  profile=validateProfile({id:'eval-local',kind:'local',label:'Explicit evaluation endpoint',url:args.endpoint,model:args.model,maxTokens:Number(args['max-tokens'])})
}
if(!args['dry-run']&&!profile)throw new Error('Select an explicit profile or local endpoint, or use --dry-run')
if(profile&&!['local','codex','claude','muse'].includes(profile.kind))throw new Error('Cloud API evaluation is disabled; this runner does not load API keys')
if(!args['dry-run']&&profile?.kind!=='local'&&!args['allow-subscription'])throw new Error('Subscription evaluation requires --allow-subscription and consumes subscription usage')
const selected=cases.filter(c=>!args.case||args.case.includes(c.id))
if(args.case?.some(id=>!cases.some(c=>c.id===id)))throw new Error('Unknown --case ID')
const suiteHash=createHash('sha256').update(JSON.stringify(cases)).digest('hex')
const sourceHashes=Object.fromEntries(['planner.js','providers.js','direct-plan.js','intent.js','teammate-prompt.txt'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../src/companion/'+name,import.meta.url))).digest('hex')]))
const receipt={formatVersion:1,scope:'synthetic-observation-planning-only',inWorldSuccess:null,semanticReviewRequired:true,dryRun:!!args['dry-run'],suiteHash,sourceHashes,profile:profile?{id:profile.id,kind:profile.kind,model:profile.model,maxTokens:profile.maxTokens}:null,startedAt:new Date().toISOString(),results:[]}
for(const c of selected){
  const isDirect=!c.observation.feedback?.length&&!!directPlan(c.text,c.observation)
  const result={id:c.id,note:c.note,path:isDirect?'direct-rule':'model-request',checks:c.checks}
  if(args['dry-run']){result.status='not-run';receipt.results.push(result);continue}
  const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
  let httpRequests=0;planner.fetcher=(...a)=>{httpRequests++;return fetch(...a)}
  const start=performance.now()
  try{
    result.plan=validatePlan(await planner.plan(c.text,structuredClone(c.observation),structuredClone(c.history),AbortSignal.timeout(150000)))
    result.runtimeValidationPassed=true
    result.checks=scorePlan(result.plan,c.checks)
    result.status=result.checks.every(x=>x.passed)?'assertions-passed':'assertions-failed'
  }catch(error){result.status='error';result.error=error.message;result.runtimeValidationPassed=false}
  result.latencyMs=Math.round(performance.now()-start)
  result.httpRequests=profile.kind==='local'?httpRequests:null
  result.subscriptionRequested=profile.kind!=='local'&&!isDirect
  receipt.results.push(result)
  console.log(`${c.id}: ${result.status} (${result.path}, ${result.latencyMs} ms)`)
}
receipt.finishedAt=new Date().toISOString()
const out=args.out?resolve(args.out):null
if(out){mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(`Receipt: ${out}`)}else console.log(JSON.stringify(receipt,null,2))
if(receipt.results.some(r=>['error','assertions-failed'].includes(r.status)))process.exitCode=1
