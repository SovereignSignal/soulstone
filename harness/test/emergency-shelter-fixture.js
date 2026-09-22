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
  bot.blockAt=p=>({name:p.x===feet.x&&p.z===feet.z&&p.y>=feet.y&&p.y<ceiling?'air':'dirt',position:p.clone(),boundingBox:p.x===feet.x&&p.z===feet.z&&p.y>=feet.y&&p.y<ceiling?'empty':'block'})
 }else if(['unburrow','unhut'].includes(command.action)&&this.fixtureOutside){
  Object.assign(bot,{blockAt:this.fixtureOutside.blockAt});bot.entity.position=this.fixtureOutside.position;delete this.fixtureOutside
 }
 return value
}
