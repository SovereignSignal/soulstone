// Flee: sprint directly away from a threat that must not be fought or waited
// out at close range. A creeper starts swelling within three blocks whether or
// not it can see the bot, so distance is the only defence while unarmed.
import pathfinding from 'mineflayer-pathfinder'
import {DoorAwareMovements} from './navigation.js'
const {goals}=pathfinding
export const FLEE_DISTANCE=24
export function fleeTarget(position,from,distance=FLEE_DISTANCE){
 let dx=position.x-from.x,dz=position.z-from.z,len=Math.hypot(dx,dz)
 // Standing on top of the threat leaves no direction: pick east and go.
 if(len<1e-6){dx=1;dz=0;len=1}
 return {x:Math.round(position.x+dx/len*distance),z:Math.round(position.z+dz/len*distance)}
}
export function validateFleeGoal(goal){
 const from=goal?.from
 if(!from||!['x','y','z'].every(k=>Number.isFinite(from[k])))throw new Error('Flee needs the threat position')
 const distance=goal.distance??FLEE_DISTANCE
 if(!Number.isInteger(distance)||distance<8||distance>48)throw new Error('Flee distance must be 8–48')
 return {from:{x:from.x,y:from.y,z:from.z},distance}
}
export async function fleeFrom(bot,task,{check,stage,progress,movements}){
 const {from,distance}=validateFleeGoal(task.goal)
 check()
 if(!(bot.food>6))throw new Error('Too hungry to sprint')
 const start=bot.entity.position.clone(),target=fleeTarget(start,from,distance)
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:true,scafoldingBlocks:[],maxDropDown:2})
 stage('fleeing');progress(`Sprinting away from the threat toward ${target.x},${target.z}`)
 bot.pathfinder.setMovements(movement);bot.setControlState('sprint',true)
 const timer=setTimeout(()=>bot.pathfinder.setGoal(null),12000)
 try{await bot.pathfinder.goto(new goals.GoalXZ(target.x,target.z))}catch{}finally{clearTimeout(timer);bot.setControlState('sprint',false);bot.pathfinder.setGoal(null);if(movements)bot.pathfinder.setMovements(movements)}
 check()
 const p=bot.entity.position,gained=Math.hypot(p.x-from.x,p.z-from.z)-Math.hypot(start.x-from.x,start.z-from.z)
 if(p.distanceTo(start)<2)throw new Error('No route away from here')
 return {item:'safety',count:1,receipt:'fled',moved:Math.round(p.distanceTo(start)),gained:Math.round(gained),position:{x:p.x,y:p.y,z:p.z}}
}
