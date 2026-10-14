// Playful actions for the people the bot plays with. A child's first word to it in the
// creative world (14 October 2026) was "jump", and it had nothing to answer with. Short,
// bounded, in place: the safety tick still preempts them like any other task.
export const EMOTES=['jump','wave','spin','dance','nod']
const delay=ms=>new Promise(r=>setTimeout(r,ms))
export function validateEmoteGoal(g){
 const move=String(g?.move||''),count=Number.isInteger(g?.count)?g.count:1
 if(!EMOTES.includes(move))throw new Error(`Emote must be one of: ${EMOTES.join(', ')}`)
 if(count<1||count>5)throw new Error('Emote count is 1 to 5')
 return {move,count}
}
export async function performEmote(bot,task,{check,stage,progress},{beatMs=350}={}){
 const {move,count}=validateEmoteGoal(task.goal)
 stage('emoting');progress(`${move} x${count}`)
 const yaw=bot.entity?.yaw??0,pitch=bot.entity?.pitch??0
 try{
  for(let i=0;i<count;i++){
   check()
   if(move==='jump'||move==='dance'){bot.setControlState('jump',true);await delay(beatMs);bot.setControlState('jump',false);await delay(beatMs)}
   if(move==='wave'){bot.swingArm?.('right');await delay(beatMs);bot.swingArm?.('left');await delay(beatMs)}
   if(move==='spin'||move==='dance')for(let q=1;q<=4;q++){await bot.look(yaw+q*Math.PI/2,pitch,true);await delay(Math.round(beatMs/2))}
   if(move==='nod'){await bot.look(yaw,0.6,true);await delay(beatMs);await bot.look(yaw,-0.3,true);await delay(beatMs)}
  }
 }finally{bot.setControlState('jump',false);try{await bot.look(yaw,pitch,true)}catch{}}
 return {item:'emote',count,move,receipt:'performed'}
}
