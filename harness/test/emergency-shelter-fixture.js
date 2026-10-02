import {Vec3} from 'vec3'
import {Teammate} from '../src/companion/controller.js'

// Controller tests stub the executor. Give successful shelter commands their
// physical effects too, so the live enclosure watch can inspect actual blocks.
export async function executeWithShelter(command,signal){
 const value=await Teammate.prototype.execute.call(this,command,signal)
 const bot=this.runner.bot,result=this.runner.task.result
 if(['burrow','hut'].includes(command.action)){
  const s=result.surface,feet=new Vec3(s.x,s.y-(command.action==='burrow'?4:0),s.z)
  this.fixtureOutside={position:bot.entity.position.clone(),blockAt:bot.blockAt}
  bot.entity.position=feet.offset(.5,0,.5)
  const ceiling=command.action==='burrow'?s.y-1:s.y+2
  // Open air above the ground the shelter was dug or built on, as in a world:
  // only the cap, the hut's shell and the ground itself are solid.
  const inside=p=>p.x===feet.x&&p.z===feet.z&&p.y>=feet.y&&p.y<ceiling
  const shell=p=>command.action==='hut'&&Math.abs(p.x-feet.x)<=1&&Math.abs(p.z-feet.z)<=1&&p.y<=s.y+2
  const open=p=>inside(p)||p.y>=s.y&&!shell(p)
  bot.blockAt=p=>({name:open(p)?'air':'dirt',position:p.clone(),boundingBox:open(p)?'empty':'block'})
 }else if(['unburrow','unhut'].includes(command.action)&&this.fixtureOutside){
  Object.assign(bot,{blockAt:this.fixtureOutside.blockAt});bot.entity.position=this.fixtureOutside.position;delete this.fixtureOutside
 }
 return value
}
