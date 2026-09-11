import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {compileArchitecture} from '../construction.js'
export const reflectionSchema={type:'object',additionalProperties:false,required:['lessons'],properties:{lessons:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['when','strategy','limits','evidence'],properties:{when:{type:'string'},strategy:{type:'string'},limits:{type:'string'},evidence:{type:'array',items:{type:'integer'},minItems:1,maxItems:4}}}}}}
// Extract outcomes and geometry properties, never persist a route/blueprint as
// the reusable strategy. Claims about causes remain model hypotheses.
export function experienceEvidence(feedback,verification) {
 return feedback.filter(f=>f.action!=='goal_check').map(f=>{
  const e={action:f.action,status:f.status,item:f.step?.item||f.result?.item||'',partial:!!f.result?.partial,reason:(f.reason||'').replace(/-?\d+,\s*-?\d+,\s*-?\d+/g,'[position]').slice(0,400)}
  if(f.status==='completed'){
   if(['construct','revise'].includes(f.action)&&!f.result?.partial&&f.task?.goal?.design){const b=compileArchitecture(f.task.goal.design);e.facts={placedBlocks:b.blocks.length,walked:f.result.walkthrough.length,height:Math.max(...b.checks.map(p=>p.y)),materials:[...new Set(b.blocks.map(b=>b.block))],verified:verification?.verdict==='passed'}}
   else e.facts={count:f.result?.count??null,receipt:f.result?.receipt||null,needs:f.result?.needs||[],...(f.result?.partial?{acquired:f.result.acquired===true,broken:f.result.broken||0,steps:f.result.steps||0,returned:f.result.returned===true}:{})}
  }
  return e
 }).slice(-24)
}
export class ExperienceStore {
 constructor(path,profile){this.path=path;this.profile=profile;this.entries=[];try{const s=JSON.parse(readFileSync(path,'utf8'));if(s.schema!==1||s.profile!==profile)throw new Error('Experience belongs to another profile');this.entries=s.entries}catch(e){if(e.code!=='ENOENT')throw e}}
 record({requestId,summary,criteria,version,evidence,reflection,verdict}){
  if(!evidence?.length)return
  const previous=this.entries.find(e=>e.requestId===requestId)
  const lessons=(Array.isArray(reflection?.lessons)?reflection.lessons:[]).filter(l=>['when','strategy','limits'].every(k=>typeof l[k]==='string'&&l[k].length<=600)&&Array.isArray(l.evidence)&&l.evidence.length&&l.evidence.every(i=>Number.isInteger(i)&&evidence[i]))
   .map(l=>({...l,evidence:[...new Set(l.evidence)],status:'conditional_hypothesis'}))
  if(previous&&JSON.stringify([previous.evidence,previous.verdict,previous.lessons])===JSON.stringify([evidence,verdict,lessons]))return
  const at=new Date().toISOString(),outcome={at,verdict,blockers:evidence.filter(e=>e.status==='failed'||e.partial).map(e=>({action:e.action,item:e.item,reason:e.reason,needs:e.facts?.needs||[]})).slice(-6)}
  const outcomes=previous?.outcomes|| (previous?[{at:previous.at,verdict:previous.verdict,blockers:previous.evidence.filter(e=>e.status==='failed'||e.partial).map(e=>({action:e.action,item:e.item,reason:e.reason,needs:e.facts?.needs||[]})).slice(-6)}]:[])
  this.entries=this.entries.filter(e=>e.requestId!==requestId)
  this.entries.push({id:previous?.id||randomUUID(),requestId,at,summary:summary.slice(0,600),criteria:criteria.map(c=>c.kind),version,verdict,evidence,lessons,outcomes:[...outcomes,outcome].slice(-8)})
  this.entries=this.entries.slice(-80);mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify({schema:1,profile:this.profile,entries:this.entries}),{mode:0o600});renameSync(this.path+'.tmp',this.path)
 }
 retrieve(request,contract,version){
  const tokens=new Set(request.toLowerCase().match(/[a-z]{4,}/g)||[]),types=new Set(contract?.criteria?.map(c=>c.kind)||[])
  return this.entries.filter(e=>e.version===version).map(e=>({entry:e,score:e.criteria.reduce((n,k)=>n+(types.has(k)?4:0),0)+[...tokens].filter(t=>(e.summary+' '+e.lessons.map(l=>l.when).join(' ')).toLowerCase().includes(t)).length}))
   .filter(e=>e.score>0).sort((a,b)=>b.score-a.score||b.entry.at.localeCompare(a.entry.at)).slice(0,4).map(({entry:e})=>({id:e.id,version:e.version,summary:e.summary,verdict:e.verdict,evidence:e.evidence,lessons:e.lessons,outcomes:e.outcomes||[]}))
 }
}
