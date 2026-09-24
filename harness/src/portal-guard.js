import {setTimeout as delay} from 'node:timers/promises'
import {portalObservation} from './survival.js'
import {standable} from './fire-safety.js'

// Sov's limit: never step through a portal or enter the Nether. A survival
// player standing in a nether portal is carried through after four seconds,
// so this never waits for a model or a path search: it faces the nearest
// standing cell outside the portal and walks.
export async function leavePortal(bot,task,{check,stage,progress},{pollMs=50,stepMs=2000}={}){
 const inside=()=>portalObservation(bot).inPortal===true
 const here=()=>{const p=bot.entity.position.floored();return {x:p.x,y:p.y,z:p.z}}
 check()
 if(!inside())return {item:'safety',count:0,receipt:'not_in_portal',position:here()}
 stage('leaving_portal');progress('I am standing in a portal. Stepping out before it carries me to the Nether')
 const center=bot.entity.position.floored(),out=[]
 for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(const dy of [0,-1,1]){
  const p=center.offset(dx,dy,dz)
  if((dx||dz)&&standable(bot,p)&&![0,1].some(y=>/portal/.test(bot.blockAt(p.offset(0,y,0))?.name||'')))out.push(p)
 }
 out.sort((a,b)=>a.distanceTo(center)-b.distanceTo(center))
 try{
  for(const target of out.slice(0,3)){
   check()
   await bot.lookAt(target.offset(.5,.5,.5),true)
   bot.setControlState('forward',true);if(target.y>center.y)bot.setControlState('jump',true)
   const end=Date.now()+stepMs
   while(inside()&&Date.now()<end){check();await delay(pollMs)}
   bot.clearControlStates()
   if(!inside())return {item:'safety',count:1,receipt:'out_of_portal',position:here()}
  }
 }finally{bot.clearControlStates()}
 throw new Error(`Still in the portal after ${Math.min(3,out.length)} step${out.length===1?'':'s'} toward open ground`)
}
