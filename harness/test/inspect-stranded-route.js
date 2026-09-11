import mineflayer from 'mineflayer'
import pathfinding from 'mineflayer-pathfinder'
import {once} from 'node:events'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Vec3} from 'vec3'
import assert from 'node:assert/strict'
import {DoorAwareMovements} from '../src/navigation.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json()
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c+"'"],{timeout:15000})).stdout
const bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
bot.loadPlugin(pathfinding.pathfinder)
const report={position:s.position,paths:[]}
try{
 await once(bot,'spawn');await rcon('gamemode spectator HarnessWitness');await rcon(`tp HarnessWitness ${s.position.x} ${s.position.y+5} ${s.position.z}`);await bot.waitForChunksToLoad()
 const start=new Vec3(s.position.x,s.position.y,s.position.z),o=s.projects.base.build.origin,goal=new pathfinding.goals.GoalNear(o.x+1.5,o.y,o.z-1.5,1)
 for(const drop of [1,3]){
  const m=new DoorAwareMovements(bot);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.allowFreeMotion=false;m.allowSprinting=false;m.scafoldingBlocks=[];m.maxDropDown=drop;m.blocksToAvoid.add(bot.registry.blocksByName.sweet_berry_bush.id)
  let result;const it=bot.pathfinder.getPathFromTo(m,start,goal,{timeout:5000,tickTimeout:40,optimizePath:false})
  for(const x of it)result=x.result
  report.paths.push({drop,status:result.status,path:result.path.map(p=>({x:p.x,y:p.y,z:p.z,breaks:p.toBreak,places:p.toPlace}))})
 }
}finally{bot.quit();writeFileSync('results/stranded-route-inspection.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
