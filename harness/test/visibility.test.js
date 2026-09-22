import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {observedSightline} from '../src/visibility.js'
import {survivalObservation,emergencyReason,THREAT_INTERRUPTION} from '../src/survival.js'
import {forcedInterruption} from '../src/threat-judgement.js'

test('sightline requires loaded terrain and distinguishes a blocking wall from a clear ray',()=>{
 const from=new Vec3(0,66,0),to=new Vec3(5,65,0),bot={blockAt:()=>({name:'air'}),world:{raycast:()=>null}}
 assert.equal(observedSightline(bot,from,to).status,'clear')
 bot.world.raycast=()=>({name:'stone'});assert.deepEqual(observedSightline(bot,from,to),{status:'blocked',block:'stone'})
 bot.blockAt=p=>p.x===3?null:{name:'air'};assert.equal(observedSightline(bot,from,to).status,'unknown')
 assert.equal(observedSightline(bot,from,new Vec3(100,65,0)).status,'unknown')
 assert.equal(observedSightline({},from,to).status,'unknown')
})
test('observed occlusion and elevation never remove a hostile or weaken immediate safety floors',()=>{
 const bot={entity:{position:new Vec3(0,70,0)},entities:{1:{name:'creeper',position:new Vec3(0,62,0)}},blockAt:()=>({name:'stone'}),world:{raycast:()=>({name:'stone'})},game:{gameMode:'survival',difficulty:'easy'},health:17,food:5,time:{timeOfDay:6000},inventory:{items:()=>[]}}
 const s=survivalObservation(bot)
 assert.equal(s.nearbyThreats[0].verticalOffset,-8);assert.equal(s.nearbyThreats[0].sightline.status,'blocked');assert.equal(s.nearbyThreats[0].risk,'potential_hostile')
 assert.equal(emergencyReason(s),THREAT_INTERRUPTION);assert.match(forcedInterruption(s),/creeper/)
})
