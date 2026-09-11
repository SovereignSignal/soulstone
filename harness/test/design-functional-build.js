import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {compileArchitecture,reviewArchitecture} from '../src/construction.js'
import {writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const planner=new LocalPlanner(),profile=new ModelProfiles('state/models.json').profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra');assert.ok(profile);planner.profiles={current:profile,key:''}
const request='Design a small usable stone gatehouse with a wooden door, a fence gate, and an accessible raised lookout using real stair blocks. Return one construct step named gatehouse_trial. The lab supplies items and a clear level pad, so do not acquire or place anything yet. Use stone_bricks, stone_brick_stairs, oak_door, spruce_fence_gate and glowstone. Keep coordinates x/z between 0 and 10, y between 0 and 5, and at most 100 placed items. Choose your own layout. Include covered interior space, a door and gate that can each be crossed along their facing axis with level supported clear approaches, and a straight bottom-half stair flight reaching a full-block lookout landing at least 2 above ground. Checkpoints must include outside, interior, upper landing and outside again. Respect all stateful-block and passage constraints in your tool instructions. Leave access for building and verification.'
writeFileSync('results/functional-build-request.txt',request)
const plan=await planner.plan(request,{connected:true,ownerVisible:true,position:{x:0,y:64,z:0},inventory:{},feedback:[],projects:{}},[],AbortSignal.timeout(180000),'',t=>writeFileSync('results/functional-build-trace.json',JSON.stringify(t,null,2)))
const step=plan.steps.find(s=>s.action==='construct');assert.ok(step)
const bp=compileArchitecture(step.design);assert.equal(reviewArchitecture(bp).unreachable.length,0)
for(const suffix of ['_door','_fence_gate','_stairs'])assert.ok(bp.blocks.some(b=>b.block.endsWith(suffix)))
assert.ok(bp.blocks.length<=100);assert.ok(bp.checks.some(p=>p.y>=2));assert.ok(bp.cells.every(p=>p.x>=0&&p.x<=10&&p.z>=0&&p.z<=10&&p.y<=5))
writeFileSync('results/functional-build-blueprint.json',JSON.stringify(step,null,2));console.log(JSON.stringify({model:profile.model,blocks:bp.blocks.length,checks:bp.checks.length,reply:plan.reply}))
