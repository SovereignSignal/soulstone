// Natural ground: what the bot may break when a walk or a dig step tunnels.
// In a world it shares with players (the family world, from 4 October 2026)
// it must never cut through what someone built, so the general digging walk
// and the dig action break only blocks that generate in the world: stone and
// its kin, soil, sand and gravel, ores, leaves, snow, and the Nether's and
// End's ground. Planks, logs, cobblestone, glass, wool, bricks and every other
// building block are routed around or refused, even when that costs a detour.
export const NATURAL=new Set([
 'stone','deepslate','tuff','granite','diorite','andesite','calcite','dripstone_block','basalt','smooth_basalt','blackstone',
 'dirt','grass_block','coarse_dirt','podzol','rooted_dirt','mud','clay','mycelium','moss_block',
 'sand','red_sand','gravel','sandstone','red_sandstone','terracotta','snow','snow_block','powder_snow',
 'netherrack','soul_sand','soul_soil','magma_block','end_stone','sculk','ancient_debris','amethyst_block','budding_amethyst',
])
export const isNatural=name=>!!name&&(NATURAL.has(name)||/_ore$/.test(name)||/_leaves$/.test(name)||/_terracotta$/.test(name)&&!/glazed/.test(name))
// The Nether's forest floor and growth (lab run 152, 15 October: a dig toward the blaze
// spawner stopped at crimson nylium as if a player had built it). 16 October: ground only
// in the Nether; in the Overworld glowstone is a lamp and a wart block a decoration.
export const NETHER_NATURAL=new Set(['crimson_nylium','warped_nylium','nether_wart_block','warped_wart_block','glowstone','gilded_blackstone'])

// The cells the bot itself filled (run 76, 8 October: in the Nether it stood
// on a pillar of its own cobblestone above the portal and the dig action
// refused every block of it). Its scaffolding, hut walls, caps and pillars
// are its own to clear; a player's build never passed through the bot's
// placeBlock, so it stays refused. Kept on the runner across reconnects and
// saved beside the task state across restarts; the oldest are forgotten
// first past OWN_LIMIT.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {dimensionOf,inNether} from './dimension.js'
export const OWN_LIMIT=4096,OWN_TTL_MS=2*3600*1000
// Lab run 162, 15 October: through the version bridge placeBlock can give up on
// the update while the block lands a moment later, inside the placing skill's
// own settle, and the dig step then refused the bot's re-closed firing port. A
// placement into an empty cell that has not landed when placeBlock returns is
// held for PENDING_MS; the skill that sees the block land claims it (claimPlaced).
export const PENDING_MS=10000
// Keyed by dimension and cell, holding the block seen there after placing:
// a cell counts only in its own dimension, only while it still holds that
// block, and only for two hours (it is for scaffolding, hut walls and
// pillars, cleared soon after they are placed). A cell whose block is seen
// changing is forgotten, and only a cell that was empty when the bot placed
// into it is recorded (reviews of 2695c14 and cb0f914).
const cellKey=(p,dimension)=>`${dimension||'overworld'}|${p.x},${p.y},${p.z}`
export class OwnBlocks {
 constructor(path=null){
  this.path=path;this.cells=new Map();this.pending=new Map()
  try{if(path)for(const e of JSON.parse(readFileSync(path,'utf8')))if(Array.isArray(e)&&typeof e[0]==='string'&&typeof e[1]?.name==='string'&&Number.isFinite(e[1]?.at))this.cells.set(e[0],{name:e[1].name,at:e[1].at})}catch{}
 }
 has(p,name,dimension){const e=p&&name?this.cells.get(cellKey(p,dimension)):null;return !!e&&e.name===name&&Date.now()-e.at<OWN_TTL_MS}
 entry(p,dimension){return p?this.cells.get(cellKey(p,dimension))||null:null}
 add(p,name,dimension){
  const k=cellKey(p,dimension);this.cells.delete(k);this.cells.set(k,{name,at:Date.now()})
  while(this.cells.size>OWN_LIMIT)this.cells.delete(this.cells.keys().next().value)
  this.save()
 }
 forget(p,dimension){if(this.cells.delete(cellKey(p,dimension)))this.save()}
 // A placement sent into an empty cell that has not landed yet; not saved, as it lives only seconds.
 expect(p,dimension){const now=Date.now();for(const [k,at] of this.pending)if(now-at>=PENDING_MS)this.pending.delete(k);this.pending.set(cellKey(p,dimension),now)}
 claim(p,block,dimension){
  const k=cellKey(p,dimension),at=this.pending.get(k)
  if(at==null||Date.now()-at>=PENDING_MS||!block||block.boundingBox!=='block')return false
  this.pending.delete(k);this.add(p,block.name,dimension);return true
 }
 save(){if(this.path)try{mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify([...this.cells]))}catch{}}
}
// Wraps placeBlock, which the bot's own cubes go through, the pathfinder's
// towering included. Oriented build pieces (building-blocks.js) and the use
// action (use-item.js) place through mineflayer's lower calls and are not recorded.
export function trackOwnPlacements(bot,own){
 bot.ownBlocks=own
 if(bot._ownPlacementsTracked||typeof bot.placeBlock!=='function')return
 bot._ownPlacementsTracked=true
 const place=bot.placeBlock.bind(bot)
 bot.placeBlock=async(ref,face,...rest)=>{
  const p=ref?.position&&face?ref.position.plus(face):null,before=p?bot.blockAt?.(p):null,empty=!before||before.boundingBox!=='block'
  try{return await place(ref,face,...rest)}finally{
   if(p&&empty){const b=bot.blockAt?.(p);if(b&&b.boundingBox==='block')own.add(p,b.name,dimensionOf(bot));else own.expect(p,dimensionOf(bot))}}}
 bot.on?.('blockUpdate',(old,now)=>{const at=now?.position||old?.position,e=own.entry(at,dimensionOf(bot));if(e&&(now?.boundingBox!=='block'||now?.name!==e.name))own.forget(at,dimensionOf(bot))})
}
// Every skill that judges a placement by the block being there, rather than by
// placeBlock's answer, calls this once it sees the block: the hut's walls and
// re-closed port, fillCell's scaffolding and plugs, the burrow's cap and climb.
export const claimPlaced=(bot,cell)=>!!bot?.ownBlocks?.claim&&!!cell&&bot.ownBlocks.claim(cell,bot.blockAt?.(cell),dimensionOf(bot))
// The hut's own walls, whatever their age: a hut can be held past OWN_TTL_MS (four watches and
// a Resume) and must still open (review of 16 October). A cell whose block changes is forgotten
// on its blockUpdate, so a player's replacement is not taken for the bot's.
export const ownedNow=(bot,block)=>{const e=block?.position&&block?.name?bot?.ownBlocks?.entry?.(block.position,dimensionOf(bot)):null;return !!e&&e.name===block.name}
export const breakable=(bot,block)=>isNatural(block?.name)||inNether(bot)&&NETHER_NATURAL.has(block?.name)||!!bot?.ownBlocks?.has(block?.position,block?.name,dimensionOf(bot))
