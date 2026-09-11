import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {compileArchitecture} from '../src/construction.js'
import {writeFileSync} from 'node:fs'
const planner=new LocalPlanner();planner.profiles=new ModelProfiles('state/models.json')
const request='Design a usable compact medieval castle for our construction lab. Return exactly one construct step named castle. Available materials are stone_bricks, cobblestone, spruce_planks, glowstone. Site is a prepared flat 15x15 pad; keep ALL coordinates x/z between 0 and 10, y between 0 and 8. Build an 11x11 stone keep, four distinct corner turrets with battlements, a walkable interior, a wide front entry, a roof terrace and a permanent full-block staircase that reaches the roof. Include lighting. Solid full blocks only, so use supported full-block steps, not slab/stair items. Upper turrets must be reachable from terrace with additional full-block steps if needed. Use compact ordered cuboids, then air carve openings/stairwell. Check route headroom carefully: feet and head both need clear space above EVERY step. Define checkpoint positions on the ground outside entrance, inside hall, stair landing, roof terrace, four turret tops, and back outside. Keep total solid blocks below 700. User specifically asks to build a castle. Lab materials/site will be supplied. Do not gather yet; only return the construction design.'
writeFileSync('results/castle-design-request.txt',request)
const plan=await planner.plan(request,{connected:true,ownerVisible:true,position:{x:0,y:64,z:0},inventory:{},feedback:[],projects:{}},[],new AbortController().signal,'',d=>writeFileSync('results/castle-design-trace.json',JSON.stringify(d,null,2)))
const step=plan.steps.find(s=>s.action==='construct');if(!step)throw new Error('No castle design returned')
const b=compileArchitecture(step.design)
writeFileSync('results/castle-blueprint.json',JSON.stringify(step,null,2))
console.log(JSON.stringify({reply:plan.reply,regions:b.design.length,blocks:b.blocks.length,checks:b.checks,materials:b.blocks.reduce((m,b)=>(m[b.block]=(m[b.block]||0)+1,m),{})}))
