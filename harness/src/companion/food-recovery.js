import {survivalObservation} from '../survival.js'
import {openGroundClearance} from './hazard-clearance.js'
import {canResume,canContinueAfterSafety,interruptedEffect,continuationMark} from './continuity.js'

// Feeding on clear daylight ground does not require building a new shelter.
// Observe throughout consumption; renewed danger falls back to normal recovery.
export async function eatOnClearGround(c,epoch,signal,bot,eligible){
 const request=c.requestProgress,connection=c.runner.connectionId,health=bot.health
 const current=()=>!signal.aborted&&c.epoch===epoch&&c.requestProgress===request&&c.runner.ready&&c.runner.bot===bot&&c.runner.connectionId===connection
 const clear=()=>{
  const s=survivalObservation(bot)
  return bot.health>=health&&s.gameMode==='survival'&&['easy','normal','hard','peaceful'].includes(s.difficulty)&&s.headSubmerged===false&&bot.entity?.onGround===true&&!bot.entity.isInWater&&!bot.entity.isInLava&&openGroundClearance(bot).clear
 }
 const food=survivalObservation(bot).carriedFood[0]
 if(!current()||request?.reviewRequired||!food||!clear())return false
 const feeding=new AbortController(),combined=AbortSignal.any([signal,feeding.signal])
 let unsafe=false
 const monitor=setInterval(()=>{
  if(!current()||!clear()){
   unsafe=true;feeding.abort()
   if(current())c.dispatch({action:'stop'})
  }
 },100)
 c.say('I have food and clear daylight ground. Eating before continuing the saved request.')
 let result
 try{
  await c.execute({action:'eat',goal:{item:food.name,count:Math.min(8,food.count)},timeoutMs:30000},combined)
  if(!current())return false
  result=structuredClone(c.runner.task.result)
  if(result?.receipt!=='food_consumption_verified')throw new Error('Recovery eating lacks a verified consumption receipt')
  c.safety.eating=result
  if(request)(request.feedback??=[]).push({action:'eat',status:'completed',result,automatic:true})
 }catch(error){
  if(!current())return false
  const review=interruptedEffect(c.runner.task)
  c.safety.eating={failed:error.message}
  if(request){request.reviewRequired=review||request.reviewRequired;(request.feedback??=[]).push({action:'eat',status:'failed',reason:error.message,automatic:true,...(review?{reviewRequired:review}:{})})}
  c.persist();return false
 }finally{clearInterval(monitor);feeding.abort()}
 if(!current()||unsafe||!clear()){c.persist();return false}
 const continuing=eligible&&canResume(request)&&canContinueAfterSafety(request)
 if(continuing){
  const receipt={requestId:request.id,connectionId:connection,shelter:'fed_on_clear_ground',resumeSerial:request.resumeSerial||0,...continuationMark(request),health:bot.health,hunger:bot.food}
  ;(request.safetyContinuations??=[]).push(receipt)
  ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:receipt})
 }
 c.safety=null;c.activity='';c.phase=canResume(request)?'blocked':'ready';c.persist()
 if(continuing)await c.resume({automatic:true})
 else c.say('Eating is verified. '+(canResume(request)?'The saved request remains paused at its continuation limit.':'Ready for your next instruction.'))
 return true
}
