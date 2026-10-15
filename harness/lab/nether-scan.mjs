import {readFileSync,readdirSync} from 'node:fs'
import {inflateSync,gunzipSync} from 'node:zlib'
import nbt from 'prismarine-nbt'
// Finds spawners and structure starts in a world's Nether region files, nearest first.
// node harness/lab/nether-scan.mjs <nether region dir> [x y z]
// Paper keeps them at <world>/dimensions/minecraft/the_nether/region. Read-only; copy
// the files out first rather than reading a running server's. Lab, 13 October 2026:
// /locate named a fortress 583 blocks off while this found a blaze spawner 47 from the portal.
import {join} from 'node:path'
const [dirArg,...at]=process.argv.slice(2)
if(!dirArg){console.error('usage: node nether-scan.mjs <nether region dir> [x y z]');process.exit(2)}
const dir=dirArg
const spawners=[],structs=new Map();let chunks=0,fortressChunks=0
for(const f of readdirSync(dir).filter(f=>f.endsWith('.mca'))){
 const buf=readFileSync(join(dir,f));if(buf.length<8192)continue
 for(let i=0;i<1024;i++){
  const off=(buf[i*4]<<16|buf[i*4+1]<<8|buf[i*4+2])*4096;if(!off)continue
  const len=buf.readUInt32BE(off),type=buf[off+4],raw=buf.subarray(off+5,off+4+len)
  let data;try{data=type===2?inflateSync(raw):type===1?gunzipSync(raw):null}catch{continue}
  if(!data)continue
  const {parsed}=await nbt.parse(data);const c=nbt.simplify(parsed);chunks++
  for(const be of c.block_entities||[])if(String(be.id).includes('spawner')){
   const ent=be.SpawnData?.entity?.id||be.SpawnData?.id||'?';spawners.push({x:be.x,y:be.y,z:be.z,ent})}
  const st=c.structures||{}
  for(const [k,v] of Object.entries(st.starts||{}))if(v?.id&&v.id!=='INVALID')structs.set(k+'@'+c.xPos+','+c.zPos,{id:v.id,bb:(v.Children||[]).length})
  if(Object.keys(st.References||{}).some(k=>k.includes('fortress')))fortressChunks++
 }
}
const [px,py,pz]=at.length===3?at.map(Number):[0,64,0],P={x:px,y:py,z:pz}
console.log('chunks',chunks,'fortress-referencing chunks',fortressChunks)
for(const s of spawners.sort((a,b)=>Math.hypot(a.x-P.x,a.z-P.z)-Math.hypot(b.x-P.x,b.z-P.z)))console.log('spawner',s.ent,s.x,s.y,s.z,'dist',Math.round(Math.hypot(s.x-P.x,s.y-P.y,s.z-P.z)))
for(const [k,v] of structs)console.log('structure start',k,v.id,'pieces',v.bb)
