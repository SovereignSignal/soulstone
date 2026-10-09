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

// The cells the bot itself filled (run 76, 8 October: in the Nether it stood
// on a pillar of its own cobblestone above the portal and the dig action
// refused every block of it). Its scaffolding, hut walls, caps and pillars
// are its own to clear; a player's build never passed through the bot's
// placeBlock, so it stays refused. Kept on the runner across reconnects and
// saved beside the task state across restarts; the oldest are forgotten
// first past OWN_LIMIT.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
export const OWN_LIMIT=4096
const cellKey=p=>`${p.x},${p.y},${p.z}`
export class OwnBlocks {
 constructor(path=null){
  this.path=path;this.cells=new Set()
  try{if(path)for(const k of JSON.parse(readFileSync(path,'utf8')))if(typeof k==='string')this.cells.add(k)}catch{}
 }
 has(p){return !!p&&this.cells.has(cellKey(p))}
 add(p){
  this.cells.delete(cellKey(p));this.cells.add(cellKey(p))
  while(this.cells.size>OWN_LIMIT)this.cells.delete(this.cells.values().next().value)
  if(this.path)try{mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify([...this.cells]))}catch{}
 }
}
// Wraps placeBlock, which every placement goes through, the pathfinder's
// towering included. A placement that throws may still have landed, so the
// cell is recorded either way.
export function trackOwnPlacements(bot,own){
 bot.ownBlocks=own
 if(bot._ownPlacementsTracked||typeof bot.placeBlock!=='function')return
 bot._ownPlacementsTracked=true
 const place=bot.placeBlock.bind(bot)
 bot.placeBlock=async(ref,face,...rest)=>{try{return await place(ref,face,...rest)}finally{if(ref?.position&&face)own.add(ref.position.plus(face))}}
}
export const breakable=(bot,block)=>isNatural(block?.name)||!!bot?.ownBlocks?.has(block?.position)
