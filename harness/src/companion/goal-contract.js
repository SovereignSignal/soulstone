import {milestonePlanSchema,validateMilestonePlan} from './milestones.js'
import {shelteredObservation} from '../retreat.js'
import {compileArchitecture,architectureMaterials,projectName,reviseArchitecture} from '../construction.js'
import {Vec3} from 'vec3'
import {parseBlockState,matchesExpected,dimensionOf} from '../use-item.js'
import {wornArmour} from '../threat-judgement.js'
import {usableToolCount} from '../supplies.js'
import {deliveredCount} from './progress.js'
import {resourceCount} from '../resources.js'

const kinds=['inventory','tools','delivered','stored','shelter','construction','furniture','reach_height','max_blocks','material_only','at_place','at_owner','at_base','base_ready','sheltered','block_at','review','slept','health','hunger','ate']
export const contractSchema={type:'object',additionalProperties:false,required:['kind','summary','projectMode','milestones','milestonePlan','constraints','criteria'],properties:{
 kind:{type:'string',enum:['task','question','clarification']},summary:{type:'string',minLength:1,maxLength:600},projectMode:{type:'string',enum:['new','continue','modify','inspect','none']},
 milestonePlan:milestonePlanSchema,
 milestones:{type:'array',items:{type:'string',maxLength:300},maxItems:8},constraints:{type:'array',items:{type:'string',maxLength:300},maxItems:12},
 criteria:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['kind','description','target','item','count'],properties:{kind:{type:'string',enum:kinds},description:{type:'string',minLength:1,maxLength:300},target:{type:'string',maxLength:40},item:{type:'string',maxLength:256},count:{type:'integer',minimum:0,maximum:2048}}}}
}}
const bounded=(s,max)=>typeof s==='string'&&s.length<=max
export function validateContract(v,projects={}) {
 if(!v||!['task','question','clarification'].includes(v.kind)||!['new','continue','modify','inspect','none'].includes(v.projectMode))throw new Error('Invalid goal interpretation: use an allowed kind and projectMode')
 if(!bounded(v.summary,600)||!v.summary.trim())throw new Error('Invalid goal summary: use 1–600 characters, retaining requirements in criteria and constraints')
 for(const [name,max] of [['milestones',8],['constraints',12]])if(!Array.isArray(v[name])||v[name].length>max||v[name].some(s=>!bounded(s,300)))throw new Error('Invalid goal '+name)
 if(!Array.isArray(v.criteria)||v.criteria.length>12||v.kind==='task'&&!v.criteria.length)throw new Error('Tasks require measurable completion criteria')
 // A contract of nothing but review criteria has no executable content, so the
 // request reports "the executable checks passed" without doing any of the work.
 if(v.kind==='task'&&v.criteria.every(c=>c?.kind==='review'))throw new Error('At least one completion criterion must be machine-checkable; review alone cannot verify a task')
 const aliases={},used=new Set(Object.keys(projects))
 const criteria=v.criteria.map(c=>{
  if(!c||!kinds.includes(c.kind)||!bounded(c.description,300)||!c.description||!bounded(c.target,40)||!bounded(c.item,256)||!Number.isInteger(c.count)||c.count<0||c.count>2048)throw new Error('Invalid completion criterion')
  if(['inventory','tools','delivered','stored'].includes(c.kind)&&!(/^[a-z0-9_]{1,64}$/.test(c.item)&&c.count>0))throw new Error('Inventory criteria need an item and positive target')
  if(['construction','furniture','reach_height','max_blocks','material_only'].includes(c.kind)){
   if(!projectName(c.target))throw new Error('Construction criteria need a lowercase project identifier matching [a-z][a-z0-9_-]{0,31}, excluding base, __proto__, constructor and prototype; use the same identifier for related criteria')
   if(v.projectMode==='none')throw new Error('Construction needs new, continue or inspect intent')
   if(v.projectMode==='new'&&!aliases[c.target]){let n=c.target,i=2;while(used.has(n))n=c.target.slice(0,26)+'_'+i++;aliases[c.target]=n;used.add(n)}
   if(['continue','modify','inspect'].includes(v.projectMode)&&!projects[c.target]?.construction)throw new Error('Cannot find the construction project to continue or inspect')
  }
  if(c.kind==='sheltered'&&(c.target!=='base'||c.count!==1))throw new Error('Sheltered criterion needs target base and count 1')
  if(c.kind==='slept'&&c.count!==1)throw new Error('Slept criterion needs count 1')
  if(['health','hunger'].includes(c.kind)&&(c.count<1||c.count>20))throw new Error('Health or hunger criterion needs a target of 1 to 20')
  if(c.kind==='ate'&&!(/^[a-z0-9_]{1,64}$/.test(c.item)&&c.count>0))throw new Error('Ate criterion needs a food item and a positive count')
  if(c.kind==='furniture'&&(!/^[a-z0-9_]{1,64}$/.test(c.item)||c.count<1))throw new Error('Furniture criterion needs item and count')
  if(c.kind==='material_only'&&!/^[a-z0-9_]+(?:,[a-z0-9_]+)*$/.test(c.item))throw new Error('Material constraint must list comma-separated item IDs')
  if(['reach_height','max_blocks'].includes(c.kind)&&c.count<1)throw new Error('Positive construction constraint required')
  if(c.kind==='block_at'){
   if(c.count<1||c.count>12||c.count>1&&c.target!=='')throw new Error('Block criterion needs count 1-12, and a counted one names no single position')
   if(c.target!==''&&!/^-?\d{1,8},-?\d{1,8},-?\d{1,8}$/.test(c.target))throw new Error('Block criterion target is "" or "x,y,z"')
   parseBlockState(c.item)
  }
  return {...c}
 })
 for(const c of criteria)if(aliases[c.target])c.target=aliases[c.target]
 for(const c of criteria.filter(c=>['furniture','reach_height','max_blocks','material_only'].includes(c.kind)))if(!criteria.some(p=>p.kind==='construction'&&p.target===c.target))throw new Error('A construction constraint needs its construction completion criterion')
 const milestonePlan=validateMilestonePlan(v.milestonePlan,criteria,v.kind)
 return {...v,criteria,milestonePlan,baselineProjects:Object.keys(projects)}
}
export function enforceProjectIntent(contract,step,projects) {
 if(step.action==='revise'&&!contract)throw new Error('Revision requires an interpreted modification goal')
 if(!contract||!['construct','revise'].includes(step.action))return
 if(step.action==='revise'&&contract.projectMode!=='modify')throw new Error('Revision requires explicit modify intent for an existing project')
 const targets=contract.criteria.filter(c=>c.kind==='construction').map(c=>c.target)
 if(!targets.includes(step.name))throw new Error('Use the construction project named in the goal: '+targets.join(', '))
 if(contract.projectMode==='new'&&contract.baselineProjects.includes(step.name))throw new Error('A new build cannot replay an existing project')
 if(!step.design.length&&!projects[step.name]?.construction)throw new Error('Create a fresh design for this new project; no saved blueprint exists')
 const design=step.action==='revise'?reviseArchitecture(projects[step.name]?.construction?.design||[],step.design):step.design.length?step.design:projects[step.name]?.construction.design
 const bp=compileArchitecture(design)
 for(const c of contract.criteria.filter(c=>c.target===step.name)){
  if(c.kind==='furniture'&&bp.blocks.filter(b=>b.block===c.item).length<c.count)throw new Error('Design omits required furnishing '+c.item)
  if(c.kind==='reach_height'&&Math.max(...bp.checks.map(p=>p.y))<c.count)throw new Error('The design does not provide access to the required height '+c.count)
  if(c.kind==='max_blocks'&&bp.blocks.length>c.count)throw new Error('The design exceeds the requested block budget '+c.count)
  if(c.kind==='material_only'&&bp.blocks.some(b=>!c.item.split(',').includes(b.block)))throw new Error('The design violates the requested material palette: '+c.item)
 }
}
// A task whose machine-checkable criteria all pass before any work has happened
// measures nothing: the request reports success on arrival. Real outcomes left in
// `review` do not rescue it, because review criteria are never checked at all.
export function vacuousContract(contract,snapshot,bot) {
 if(contract?.kind!=='task')return null
 const executable=contract.criteria.filter(c=>c.kind!=='review')
 if(!executable.length)return 'every criterion needs human review, so nothing can be verified'
 const {checks}=evaluateGoal(contract,snapshot,bot,[])
 if(checks.filter(c=>c.kind!=='review').every(c=>c.passed))
  return 'its checkable criteria already pass before any work, so the request would report success immediately'
 return null
}
export function evaluateGoal(contract,snapshot,bot,feedback=[]) {
 if(!contract)return null
 const current=feedback.filter(f=>f.status==='completed'),distance=p=>p&&snapshot.position?Math.hypot(p.x-snapshot.position.x,p.y-snapshot.position.y,p.z-snapshot.position.z):Infinity
 const checks=contract.criteria.map(c=>{
  let passed=false,observed=null,source='current observation'
  const construction=snapshot.projects?.[c.target],build=construction?.construction
  const receipt=current.findLast(f=>['construct','revise'].includes(f.action)&&f.result?.name===c.target&&!f.result.partial)
  if(c.kind==='inventory'){
   // Worn armour is not in inventory.items(): armour occupies player-window
   // slots 5-8 and items() starts at 9, verified live (carried reads 1, worn
   // reads 0). Without this an "iron helmet" criterion failed the moment the
   // agent put one on, and it crafted a spare to satisfy its own goal.
   const worn=wornArmour(bot).filter(n=>n===c.item).length
   observed=(c.item==='logs'?resourceCount(snapshot.inventory,'logs'):snapshot.inventory[c.item]||0)+worn
   passed=observed>=c.count
   if(worn)source='carried inventory plus worn equipment'
  }
  if(c.kind==='tools'){observed=usableToolCount(bot?.inventory?.items()||[],c.item);passed=observed>=c.count}
  if(c.kind==='delivered'){observed=deliveredCount(current,c.item);passed=observed>=c.count;source='current request pickup receipts'}
  if(c.kind==='stored'){
   const f=current.findLast(f=>['deposit','withdraw','stow','check_base'].includes(f.action));observed=f?.result?.container?.[c.item]??f?.result?.stations?.chest?.contents?.[c.item]??null;passed=observed!==null&&observed>=c.count;source='current request container receipt'
  }
  if(c.kind==='construction'){
   source='fresh construction receipt and live block check'
   if(receipt&&build?.origin){const b=compileArchitecture(build.design);const missing=architectureMaterials(b.cells,bot,new Vec3(build.origin.x,build.origin.y,build.origin.z));observed={blocks:b.blocks.length,missing:Object.values(missing).reduce((a,b)=>a+b,0),walked:receipt.result.walkthrough?.length||0};passed=observed.missing===0&&observed.walked===b.checks.length}
  }
  if(c.kind==='reach_height'){observed=receipt&&build?Math.max(...receipt.result.walkthrough.map(p=>p.y-build.origin.y)):null;passed=observed!==null&&observed+0.1>=c.count;source='current request grounded walkthrough'}
  if(c.kind==='furniture'){observed=receipt?.result.furnishings?.filter(f=>f.block===c.item).length||0;passed=observed>=c.count;source='current request furnishing access/window checks'}
  if(c.kind==='max_blocks'){observed=build?compileArchitecture(build.design).blocks.length:null;passed=observed!==null&&observed<=c.count}
  if(c.kind==='material_only'){observed=build?[...new Set(compileArchitecture(build.design).blocks.map(b=>b.block))]:null;passed=!!observed&&observed.every(n=>c.item.split(',').includes(n))}
  // Saved place names are lowercased and trimmed when they are stored, so a
  // criterion naming the same place in any other case looked at an empty slot.
  if(c.kind==='at_place'){const key=String(c.target||'').toLowerCase().trim();observed=distance(snapshot.places?.[c.target]??snapshot.places?.[key]);passed=observed<=2}
  // Following holds the bot within the pathfinder's follow radius of three, so
  // demanding two reported failure while it was following exactly as designed.
  if(c.kind==='at_owner'){observed=distance(snapshot.ownerPosition);passed=observed<=3}
  if(c.kind==='at_base'){observed=distance(snapshot.projects?.base?.stations?.crafting_table?.position);passed=observed<=5}
  if(c.kind==='base_ready'){observed=current.some(f=>f.action==='check_base'&&f.result?.receipt==='base_verified');passed=observed;source='current request base verification'}
  if(c.kind==='sheltered'){observed=shelteredObservation(bot,snapshot.projects?.base);passed=current.some(f=>f.action==='retreat'&&f.result?.receipt==='sheltered_door_closed')&&observed.passed;source='current retreat receipt and live shelter, interior and closed door inspection'}
  if(c.kind==='shelter'){observed=current.some(f=>f.action==='build'&&f.result?.usability?.status==='usable');passed=observed;source='current request shelter blocks, door and walkthrough receipt'}
  if(c.kind==='slept'){const f=current.findLast(f=>f.action==='sleep');observed=f?.result?.receipt||null;passed=observed==='slept_until_morning';source='current request sleep receipt with an observed morning wake'}
  if(c.kind==='health'){observed=snapshot.survival?.health??snapshot.health??null;passed=Number.isFinite(observed)&&observed>=c.count;source='live health observation'}
  if(c.kind==='hunger'){observed=snapshot.survival?.food??null;passed=Number.isFinite(observed)&&observed>=c.count;source='current server hunger observation'}
  if(c.kind==='ate'){observed=current.filter(f=>f.action==='eat'&&f.result?.item===c.item).reduce((n,f)=>n+(f.result?.count||0),0);passed=observed>=c.count;source='current request eating receipts'}
  // Receipt-anchored, like `construction` and `sheltered`. A bare live read would
  // mean walking through the portal you just lit un-completes the goal that
  // lighting it satisfied, and two identical needs_work verdicts become a throw.
  if(c.kind==='block_at'){
   const want=parseBlockState(c.item),here=dimensionOf(bot)
   const hits=current.filter(f=>f.action==='use'&&f.result?.receipt&&f.result.receipt!=='use_effect_unobserved'
     &&matchesExpected(f.result.observed,want)
     &&(c.target===''||c.target===`${f.result.target.x},${f.result.target.y},${f.result.target.z}`))
   const distinct=new Set(hits.map(f=>JSON.stringify(f.result.target))).size
   // null is unloaded, not a contradiction: the same loaded-versus-absent
   // distinction the executor refuses to blur.
   const contradicted=hits.some(f=>{
    if(f.result.target.dimension!==here)return false
    const b=bot?.blockAt?.(new Vec3(f.result.target.x,f.result.target.y,f.result.target.z))
    return !!b&&!matchesExpected(b,want)
   })
   observed={receipts:distinct,liveCheck:hits.some(f=>f.result.target.dimension===here)?(contradicted?'contradicted':'confirmed'):'not readable from here'}
   passed=distinct>=c.count&&!contradicted
   source='use receipts from this request, re-read live when the agent is in the same dimension'
  }
  if(c.kind==='review'){source='human review required';observed=c.description}
  return {...c,passed,observed,source}
 })
 return {verdict:checks.every(c=>c.passed)?'passed':checks.every(c=>c.passed||c.kind==='review')?'needs_review':'needs_work',checks,missing:checks.filter(c=>!c.passed).map(c=>c.description)}
}

export function constructionLimits(contract,target) {
 const limits={}
 for(const c of contract?.criteria||[])if(c.target===target){
  if(c.kind==='max_blocks')limits.maxBlocks=Math.min(limits.maxBlocks??2048,c.count)
  if(c.kind==='material_only'){const allowed=c.item.split(',');limits.materials=limits.materials?limits.materials.filter(n=>allowed.includes(n)):allowed}
 }
 return limits
}
