// A staircase through rock, dug the way a player digs one. The pathfinder
// plans a route through solid stone to an exact cell by searching, and 25 to
// 35 blocks down that search times out before a block is broken: every
// sealed-lava opening in the test and family worlds failed with "Took to long
// to decide path to goal!" (4 October), as did underground search legs.
// Here each step moves one block along whichever horizontal axis has more
// ground left to cover, and one block down while the target is lower, clearing
// the next column's feet, head and (stepping down) the head room above; with
// no horizontal ground left it digs straight down. Every block passes the dig
// action's own checks (natural ground only, no liquid against it, nothing
// falling overhead, a solid floor under the feet). Level and downward only:
// a target above is the pathfinder's job.
import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {refuseDigCell,digOne,AIR,LIQUID} from './primitives.js'
const {goals}=pathfinding
export const STAIR_STEPS=96
const key=p=>`${p.x},${p.y},${p.z}`
const open=b=>!b||AIR.has(b.name)||b.boundingBox==='empty'
async function settle(bot,predicate,message,check,ms=3000){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return;await delay(50)}
 throw new Error(message)
}
export function nextStair(feet,target,{secondary=false}={}){
 const dx=target.x-feet.x,dz=target.z-feet.z
 if(!dx&&!dz){const next=feet.offset(0,-1,0);return {next,cells:[next]}}
 const xFirst=Math.abs(dx)>=Math.abs(dz),useX=secondary?!xFirst:xFirst
 if(secondary&&!(useX?dx:dz))return null
 const [sx,sz]=useX?[Math.sign(dx),0]:[0,Math.sign(dz)]
 const down=target.y<feet.y?1:0,next=feet.offset(sx,-down,sz)
 return {next,cells:down?[next.offset(0,2,0),next.offset(0,1,0),next]:[next.offset(0,1,0),next]}
}
export const MAX_DROP=3
// The first cell at most MAX_DROP below `from` that stands on solid, dry ground,
// with nothing liquid on the way down and not below the target's level.
export function dropLanding(bot,from,target){
 for(let k=1;k<=MAX_DROP;k++){
  const cell=from.offset(0,-k,0),here=bot.blockAt(cell)
  if(!here||LIQUID.has(here.name)||cell.y<target.y)return null
  if(!open(here))return null
  const under=bot.blockAt(cell.offset(0,-1,0))
  if(under&&under.boundingBox==='block'&&!LIQUID.has(under.name))return cell
 }
 return null
}
// Whether a planned step can be taken, without digging: the floor (or a
// landing over open ground) and every block to clear.
function judgeStep(bot,feet,{next,cells},target,protectedSites){
 const floor=bot.blockAt(next.offset(0,-1,0))
 if(!floor||floor.boundingBox!=='block'||LIQUID.has(floor.name)){
  // Open ground falling away (a hillside, a ledge): when the next column is
  // already open, step down to a solid landing at most MAX_DROP below, not
  // below the target and not liquid. Rock over a hole is a cave: refused.
  const landing=cells.every(c=>open(bot.blockAt(c)))&&!LIQUID.has(floor?.name)?dropLanding(bot,next,target):null
  if(!landing)return {ok:false,reason:`no solid floor under ${key(next)} (${floor?.name??'unloaded'}); the staircase stops at ${key(feet)}`}
  return {ok:true,next:landing,cells:[]}
 }
 for(const cell of cells){
  const refusal=refuseDigCell(bot,cell,{protectedSites,role:cell.equals(next)?'feet':'head'})
  if(refusal)return {ok:false,reason:`the staircase stops at ${key(feet)}: ${refusal}`}
 }
 return {ok:true,next,cells}
}
export async function digStaircase(bot,to,{check,progress=()=>{},stage=()=>{},protectedSites=[],maxSteps=STAIR_STEPS}){
 const target=new Vec3(to.x,to.y,to.z).floored()
 let steps=0
 for(;;){
  check()
  const feet=bot.entity.position.floored()
  if(feet.equals(target))return {receipt:'staircase_arrived',steps,at:{x:feet.x,y:feet.y,z:feet.z}}
  if(target.y>feet.y)throw new Error(`the staircase only goes down or level; ${key(target)} is above ${key(feet)}`)
  if(++steps>maxSteps)throw new Error(`the staircase passed ${maxSteps} steps without reaching ${key(target)}`)
  // The step along the axis with more ground left; if that one is blocked (a
  // pit, a player's build, water), the step along the other axis, as a player
  // sidesteps (run 56: the straight line crossed a pit dug by earlier pours).
  let step=null,why=null
  for(const secondary of [false,true]){
   const plan=nextStair(feet,target,{secondary});if(!plan)continue
   const judged=judgeStep(bot,feet,plan,target,protectedSites)
   if(judged.ok){step=judged;break}
   why??=judged.reason
  }
  if(!step)throw new Error(why)
  const {next,cells}=step
  stage('digging')
  for(const cell of cells){
   const block=bot.blockAt(cell);if(open(block))continue
   await digOne(bot,block,check)
  }
  if(!(next.x===feet.x&&next.z===feet.z)){
   stage('walking')
   await bot.pathfinder.goto(new goals.GoalBlock(next.x,next.y,next.z)).catch(()=>{})
  }
  await settle(bot,()=>bot.entity.position.floored().equals(next)&&bot.entity.onGround!==false,`did not step into ${key(next)}`,check)
  if(steps%8===0)progress(`Staircase: ${steps} steps, now at ${key(next)}`)
 }
}
