import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {survivalObservation,emergencyReason,WATER_EMERGENCY} from '../src/survival.js'
import {DoorAwareMovements} from '../src/navigation.js'
import {surfaceForAir} from '../src/water-safety.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
function fixture({shore=true,rise=true}={}){
 const controls={},bot={registry,players:{},entities:{},health:20,oxygenLevel:12,food:20,game:{gameMode:'survival'},entity:{position:new Vec3(.5,61,.5),onGround:false,isInWater:true},inventory:{items:()=>[]},
  blockAt(p){const name=p.y<64?(shore&&p.x===2?'stone':'water'):'air',b=Block.fromStateId(registry.blocksByName[name].minStateId,0);b.position=p;return b},
  clearControlStates(){for(const k of Object.keys(controls))controls[k]=false},setControlState(k,v){controls[k]=v;if(k==='jump'&&v&&rise){bot.entity.position.y=63.2;bot.oxygenLevel=20}},
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){const g=goal.goals[0];bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);bot.entity.onGround=true;bot.entity.isInWater=false}}}
 const api={check(){},stage(){},progress(){},movements:new DoorAwareMovements(bot)}
 return {bot,api,controls}
}
test('submersion or low oxygen triggers before health loss, including Peaceful',()=>{
 const f=fixture();f.bot.game.difficulty='peaceful';assert.equal(emergencyReason(survivalObservation(f.bot)),WATER_EMERGENCY)
 f.bot.entity.position.y=65;f.bot.oxygenLevel=20;assert.equal(emergencyReason(survivalObservation(f.bot)),null)
 f.bot.oxygenLevel=10;assert.equal(emergencyReason(survivalObservation(f.bot)),null,'Observed breathable air must defeat stale oxygen after respawn')
 f.bot.blockAt=()=>null;assert.equal(emergencyReason(survivalObservation(f.bot)),WATER_EMERGENCY)
 f.bot.health=0;assert.equal(emergencyReason(survivalObservation(f.bot)),null)
 assert.equal(survivalObservation(null).headSubmerged,null)
})
test('ordinary movement avoids water and emergency movement permits only its surface layer',()=>{
 const {bot}=fixture(),normal=new DoorAwareMovements(bot),escape=new DoorAwareMovements(bot,{surfaceWaterOnly:true})
 assert.equal(normal.getBlock(new Vec3(0,63,0),0,0,0).safe,false)
 assert.equal(escape.getBlock(new Vec3(0,63,0),0,0,0).safe,true)
 assert.equal(escape.getBlock(new Vec3(0,62,0),0,0,0).safe,false)
})
test('air recovery reaches observed dry ground and releases swimming controls',async()=>{
 const f=fixture(),r=await surfaceForAir(f.bot,{},f.api,{pollMs:1,surfaceMs:100,shoreMs:100})
 assert.equal(r.receipt,'dry_ground_reached');assert.equal(f.bot.entity.onGround,true);assert.equal(f.controls.jump,false)
})
test('respawn on dry ground does not wait for stale air metadata to refill',async()=>{
 const f=fixture({rise:false});f.bot.entity.position=new Vec3(2.5,64,.5);f.bot.entity.onGround=true;f.bot.entity.isInWater=false;f.bot.oxygenLevel=0
 const r=await surfaceForAir(f.bot,{},f.api,{pollMs:1,surfaceMs:100,shoreMs:100})
 assert.equal(r.receipt,'dry_ground_reached');assert.equal(f.controls.jump,false)
})
test('no reachable shore reports breathing at the surface without claiming safety on land',async()=>{
 const f=fixture({shore:false}),r=await surfaceForAir(f.bot,{},f.api,{pollMs:1,surfaceMs:100})
 assert.equal(r.receipt,'breathing_at_surface');assert.equal(r.dryGround,false);assert.equal(f.controls.jump,true)
 f.bot.clearControlStates();assert.equal(f.controls.jump,false)
})
test('air recovery is bounded and cancels without leaving held movement controls',async()=>{
 const f=fixture({rise:false});await assert.rejects(surfaceForAir(f.bot,{},f.api,{pollMs:1,surfaceMs:10}),/surfacing limit/);assert.equal(f.controls.jump,false)
 const g=fixture();let calls=0;g.api.check=()=>{if(++calls===3)throw new Error('Cancelled')}
 await assert.rejects(surfaceForAir(g.bot,{},g.api,{pollMs:1,surfaceMs:100}),/Cancelled/);assert.equal(g.controls.jump,false)
})

test('a ledge the path search cannot reach from the water is climbed with forward and jump',async()=>{
 // Trial 24: a narrow water shaft with dry rock one block above its surface.
 // The pathfinder has no jump-up move out of water, so the air recovery found
 // no route, trod water, and each stall retry walked the bot back under.
 const f=fixture({shore:true})
 f.bot.pathfinder.goto=async()=>{throw Object.assign(new Error('No path to the goal!'),{name:'NoPath'})}
 f.bot.lookAt=async p=>{f.bot.lookTarget=p}
 const hold=f.bot.setControlState
 f.bot.setControlState=(k,v)=>{hold(k,v);if(k==='forward'&&v&&f.bot.lookTarget){const t=f.bot.lookTarget.floored();f.bot.entity.position=new Vec3(t.x+.5,t.y,t.z+.5);f.bot.entity.onGround=true;f.bot.entity.isInWater=false}}
 const r=await surfaceForAir(f.bot,{},f.api,{pollMs:1,surfaceMs:100,shoreMs:50,climbMs:50})
 assert.equal(r.receipt,'dry_ground_reached');assert.equal(f.bot.entity.onGround,true);assert.equal(f.controls.forward,false,'controls released')
})
