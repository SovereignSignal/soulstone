import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {compileArchitecture} from '../src/construction.js'
import assert from 'node:assert/strict'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Lab opt-in required')
const host=process.env.MC_SSH_HOST,run=promisify(execFile);assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const report={origin:{x:-582,y:65,z:-315},labMaterials:true,labPad:true,commands:[]}
const p=await rcon('data get entity SovereignSignal Pos'),xyz=[...p.matchAll(/([-+\d.eE]+)d/g)].map(m=>Number(m[1]));assert.equal(xyz.length,3)
assert.ok(xyz[0]<-586||xyz[0]>-568||xyz[2]<-319||xyz[2]>-301,'Player is in construction pad')
const commands=[]
for(const material of ['air','water','sand','sandstone','gravel'])commands.push(`fill -585 63 -318 -569 64 -302 minecraft:stone_bricks replace minecraft:${material}`)
const step=JSON.parse(readFileSync('results/castle-blueprint.json')),bp=compileArchitecture(step.design),kit=bp.blocks.reduce((m,b)=>(m[b.block]=(m[b.block]||0)+1,m),{})
for(const [name,n] of Object.entries(kit))commands.push(`give HarnessRunner minecraft:${name} ${n}`)
for(const c of commands){const response=await rcon(c);report.commands.push({command:c,response});console.log(response)}
report.kit=kit;writeFileSync('results/live-castle-setup.json',JSON.stringify(report,null,2))
