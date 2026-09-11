import mineflayer from 'mineflayer'
import pathfinding from 'mineflayer-pathfinder'
import {once} from 'node:events'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from '../src/navigation.js'
const run=promisify(execFile),a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json()
const b=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'});b.loadPlugin(pathfinding.pathfinder)
try{await once(b,'spawn',{signal:AbortSignal.timeout(20000)});await run('ssh',['-o','BatchMode=yes',process.env.MC_SSH_HOST,`sudo docker exec mc-sandbox rcon-cli 'gamemode spectator HarnessWitness'`]);await run('ssh',['-o','BatchMode=yes',process.env.MC_SSH_HOST,`sudo docker exec mc-sandbox rcon-cli 'tp HarnessWitness ${s.position.x} ${s.position.y+5} ${s.position.z}'`]);await b.waitForChunksToLoad()
const start=new Vec3(s.position.x,s.position.y,s.position.z),goal=new pathfinding.goals.GoalNear(-590.5,65,-300.5,1),report={start,probes:[],nearby:[]}
for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)for(let y=-5;y<=1;y++){const block=b.blockAt(start.floored().offset(x,y,z));if(block?.boundingBox==='block')report.nearby.push({name:block.name,position:block.position})}
for(const drop of [1,3]){const m=new DoorAwareMovements(b);Object.assign(m,{canDig:false,allow1by1towers:false,allowParkour:false,allowFreeMotion:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:drop});m.blocksToAvoid.add(b.registry.blocksByName.sweet_berry_bush.id);let result;for(const step of b.pathfinder.getPathFromTo(m,start,goal,{timeout:3000})){result=step.result;if(result.status!=='partial')break}report.probes.push({drop,status:result.status,path:result.path});if(drop===3)console.log(JSON.stringify(result.path.slice(0,12).map(p=>({position:p,floor:b.blockAt(p.floored().offset(0,-1,0))?.name}))));}
writeFileSync('results/tree-return-probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify({start,probes:report.probes.map(p=>({drop:p.drop,status:p.status,length:p.path.length,first:p.path.slice(0,6)}))}))
}finally{b.quit()}
