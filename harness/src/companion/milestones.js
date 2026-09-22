// Milestones reference the immutable goal's checks. They never create a second
// definition of success, and saved success is rechecked before planning work.
export const milestonePlanSchema={type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['id','description','dependsOn','criteria'],properties:{
 id:{type:'string',pattern:'^[a-z][a-z0-9_]{0,31}$'},description:{type:'string',minLength:1,maxLength:300},
 dependsOn:{type:'array',maxItems:12,items:{type:'string'}},criteria:{type:'array',minItems:1,maxItems:12,items:{type:'integer',minimum:0,maximum:11}}
}}}

export function validateMilestonePlan(plan,criteria,kind='task') {
 // Stored contracts and deterministic requests predate the structured plan.
 // Preserve their goal and batch execution, using one observable work stage.
 if(plan===undefined)return kind==='task'?[{id:'goal',description:'Complete the saved goal',dependsOn:[],criteria:criteria.map((_,i)=>i)}]:[]
 if(!Array.isArray(plan)||plan.length>12||kind==='task'&&!plan.length)throw new Error('Invalid milestone plan: tasks need 1–12 milestones')
 const ids=new Set(),covered=new Set()
 for(const node of plan){
  if(!node||typeof node.id!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(node.id)||ids.has(node.id)||typeof node.description!=='string'||!node.description.trim()||node.description.length>300)throw new Error('Invalid milestone identifier or description')
  ids.add(node.id)
  if(!Array.isArray(node.dependsOn)||node.dependsOn.length>12||new Set(node.dependsOn).size!==node.dependsOn.length||node.dependsOn.some(id=>typeof id!=='string'))throw new Error('Invalid milestone dependencies')
  if(!Array.isArray(node.criteria)||!node.criteria.length||node.criteria.length>12)throw new Error('Milestones need completion criterion indices')
  for(const index of node.criteria){
   if(!Number.isInteger(index)||index<0||index>=criteria.length||covered.has(index))throw new Error('Milestone criteria must reference each goal check exactly once')
   covered.add(index)
  }
 }
 if(covered.size!==criteria.length)throw new Error('Milestones must cover every goal criterion, including review requirements')
 const nodes=new Map(plan.map(n=>[n.id,n])),visiting=new Set(),visited=new Set()
 const visit=id=>{
  if(!ids.has(id))throw new Error('Unknown milestone dependency: '+id)
  if(visiting.has(id))throw new Error('Milestone dependencies contain a cycle')
  if(visited.has(id))return
  visiting.add(id);for(const dep of nodes.get(id).dependsOn)visit(dep);visiting.delete(id);visited.add(id)
 }
 for(const id of ids)visit(id)
 return structuredClone(plan)
}

export function updateMission(request,verification,{connected=true,now=Date.now()}={}) {
 if(request?.goal?.kind!=='task'||!verification)return null
 const plan=validateMilestonePlan(request.goal.milestonePlan,request.goal.criteria),previous=request.mission
 const old=previous?.requestId===request.id?new Map(previous.nodes.map(n=>[n.id,n])):new Map()
 const complete=new Set(plan.filter(n=>n.criteria.every(i=>verification.checks[i]?.passed===true)).map(n=>n.id))
 const nodes=plan.map(n=>{
  const evidence=n.criteria.map(index=>({index,...structuredClone(verification.checks[index])}))
  const waitingFor=n.dependsOn.filter(id=>!complete.has(id))
  const status=complete.has(n.id)?'verified':waitingFor.length?'waiting':evidence.every(c=>c.passed||c.kind==='review')?'needs_review':'ready'
  const prior=old.get(n.id),history=[...(prior?.history||[])]
  if(connected&&prior?.status!==status){history.push({at:now,from:prior?.status||null,to:status});if(history.length>16)history.shift()}
  return {...n,status,evidence,waitingFor,checkedAt:connected?now:prior?.checkedAt||null,lastPassedAt:connected&&status==='verified'?now:prior?.lastPassedAt||null,history,lastFailure:prior?.lastFailure||null}
 })
 const activeId=nodes.find(n=>n.status==='ready')?.id||null
 request.mission={version:1,requestId:request.id,nodes,activeId,requiresObservation:!connected,checkedAt:connected?now:previous?.checkedAt||null}
 syncMissionStatus(request)
 return request.mission
}

export function syncMissionStatus(request) {
 const mission=request?.mission
 if(!mission)return
 mission.status=request.status;mission.blocker=request.reviewRequired||request.blocker||null
 if(request.status==='verified')mission.requiresObservation=false
 if(['interrupted','cancelled','paused'].includes(request.status))mission.requiresObservation=true
 const active=mission.nodes.find(n=>n.id===mission.activeId)
 if(active&&mission.blocker)active.lastFailure={reason:mission.blocker,at:Date.now()}
}

export function missionFocus(mission) {
 if(!mission||mission.requiresObservation)return null
 return mission.nodes.find(n=>n.id===mission.activeId)||null
}
