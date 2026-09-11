import {usableToolCount} from '../supplies.js'
import {resourceCount} from '../resources.js'

export const stepKey=step=>JSON.stringify([step.action,step.name||'',step.item||'',step.count||0,
  (step.design||[]).map(b=>[b.x,b.y,b.z,b.x2??b.x,b.y2??b.y,b.z2??b.z,b.block])])
export const deliveredCount=(feedback,item)=>feedback.filter(f=>f.action==='give'&&f.status==='completed'&&f.result?.receipt==='recipient_pickup'&&f.result.item===item).reduce((n,f)=>n+f.result.count,0)
export function satisfiedStep(step,feedback,snapshot,bot) {
  const completed=feedback.findLast(f=>f.status==='completed'&&f.step&&stepKey(f.step)===stepKey(step))
  if(step.action==='revise'&&completed?.result&&!completed.result.partial)return true
  if(step.action==='eat')return bot?.food===20
  if(step.action==='prepare')return usableToolCount(bot?.inventory?.items()||[],step.item)>=step.count
  if(step.action==='give')return deliveredCount(feedback,step.item)>=step.count
  if(['acquire','harvest'].includes(step.action))return (snapshot.inventory[step.item]||0)>=step.count
  if(step.action==='gather')return resourceCount(snapshot.inventory,step.item||'oak_log')>=step.count
  if(step.action==='remember')return !!completed&&!!snapshot.places[step.name]
  if(['come','return'].includes(step.action)) {
    const target=step.action==='come'?snapshot.ownerPosition:snapshot.places[step.name]
    const p=snapshot.position
    return !!p&&!!target&&Math.hypot(p.x-target.x,p.y-target.y,p.z-target.z)<=2
  }
  if(step.action==='build'&&completed?.task?.goal?.origin) {
    // Usability includes live interactions. Never skip a requested shelter check.
    if(completed.task.goal.purpose==='shelter'||step.name==='shelter')return false
    const {origin,wood,design}=completed.task.goal
    return design.every(b=>bot.blockAt(bot.entity.position.clone().set(origin.x+b.x,origin.y+b.y,origin.z+b.z))?.name===(b.block==='wood_planks'?wood?.replace('_log','_planks'):b.block))
  }
  return false
}

// Old non-construction failures are history, not the current request's blocker.
// Saved unfinished construction still carries the geometry needed to resume.
export function currentRequestTask(task,ids){
 if(task&&!ids.has(task.id)&&(task.status==='completed'||['failed','cancelled'].includes(task.status)&&!['build','construct'].includes(task.kind)))return null
 return task
}
