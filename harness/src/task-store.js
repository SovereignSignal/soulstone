import {validateTravelGoal} from './travel.js'
import {validateGotoGoal,validateDigGoal,validateProtectedSites} from './primitives.js'
import {validatePlaceAtGoal,validateCollectGoal,validateAttackGoal} from './primitives-world.js'
import {validateHarvest} from './foraging.js'
import {validateEatGoal} from './survival.js'
import {validateDefenseGoal} from './combat.js'
import {validateFleeGoal} from './flee.js'
import {validateHuntGoal} from './hunt.js'
import {compileArchitecture,projectName,architectureChanges} from './construction.js'
import {PREPARE_ACTIONS,toolName} from './supplies.js'
import {validateObsidianGoal} from './obsidian.js'
import {EXPEDITION_ACTIONS,ORE_SOURCES} from './prospecting.js'
import {STATIONS,STATION_ACTIONS,SMELTING} from './stations.js'
import {validateDesign} from './world-skills.js'
import { validResource, isLog } from './resources.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {validateUseGoal} from './use-item.js'
const statuses = new Set(['running', 'paused', 'cancelled', 'completed', 'failed'])
export function validateGoal(goal) {
  if (!goal || !['x', 'y', 'z'].every(k => Number.isFinite(goal[k]))) throw new Error('goal requires finite x, y, z')
  if (Math.abs(goal.x) > 29999900 || Math.abs(goal.z) > 29999900 || goal.y < -64 || goal.y > 320) throw new Error('goal outside supported bounds')
  return { x: goal.x, y: goal.y, z: goal.z }
}
export function validateTaskGoal(kind, goal) {
  if(['surface','douse','leave_portal','burrow','hut','unhut'].includes(kind))return {}
  if(kind==='travel')return validateTravelGoal(goal)
  if(kind==='goto')return validateGotoGoal(goal)
  if(kind==='dig')return validateDigGoal(goal)
  if(kind==='place_at')return validatePlaceAtGoal(goal)
  if(kind==='collect')return validateCollectGoal(goal)
  if(kind==='attack')return validateAttackGoal(goal)
  if(kind==='use')return validateUseGoal(goal)
  if(kind==='sleep')return goal?.project?{project:goal.project}:{}
  if(['climb','descend'].includes(kind))return {}
  if(kind==='flee')return validateFleeGoal(goal)
  if(kind==='hunt')return validateHuntGoal(goal)
  if(kind==='unburrow')return {surface:validateGoal(goal?.surface)}
  if(kind==='defend')return validateDefenseGoal(goal)
  if(['retreat','leave_base'].includes(kind)&&goal?.shelter){
    const s=goal.shelter;if(goal.project||!projectName(s.name))throw new Error('Invalid fallback shelter name or ambiguous goal')
    return {shelter:{name:s.name,construction:{origin:validateGoal(s.construction?.origin),design:compileArchitecture(s.construction?.design).design}}}
  }
  if(kind==='harvest')return validateHarvest(goal)
  if(kind==='eat')return validateEatGoal(goal)
  // Smelt finds or places its own furnace, so it runs without a base that has an origin.
  if(kind==='smelt'&&!goal?.project?.build?.origin){
    if(!Object.hasOwn(SMELTING,goal?.item)||!Number.isInteger(goal.count)||goal.count<1||goal.count>16)throw new Error('Unsupported furnace recipe or count outside 1–16')
    return {project:null,item:goal.item,count:goal.count}
  }
  if([...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(kind)) {
    const p=goal?.project
    if(!p?.build?.origin||!isLog(p.build.wood))throw new Error('A saved base with an origin and wood material is required')
    validateGoal(p.build.origin);validateDesign(p.build.design)
    for(const [name,station] of Object.entries(p.stations||{})){if(!STATIONS.includes(name))throw new Error('Unknown base station');validateGoal(station.position);if(Math.hypot(station.position.x-p.build.origin.x,station.position.y-p.build.origin.y,station.position.z-p.build.origin.z)>32)throw new Error('Station outside base bounds')}
    if(kind==='prospect'&&(!ORE_SOURCES[goal.item]||!Number.isInteger(goal.count)||goal.count<1||goal.count>16))throw new Error('Prospect needs a supported ore output and total 1–16')
    if(p.expedition){for(const route of [p.expedition.trail,p.expedition.frontier]){if(!Array.isArray(route)||route.length>320)throw new Error('Invalid expedition route');for(const point of route)validateGoal(point)}}
    if(kind==='place'&&(!STATIONS.includes(goal.item)||goal.count!==1))throw new Error('Place one supported workstation or torch')
    if(['deposit','withdraw','smelt'].includes(kind)&&(!/^[a-z0-9_]{1,64}$/.test(goal.item||'')||!Number.isInteger(goal.count)||goal.count<1||goal.count>64))throw new Error('Station item target must be 1–64')
    if(kind==='smelt'&&(goal.count>16||!SMELTING[goal.item]))throw new Error('Unsupported furnace recipe')
    return {project:structuredClone(p),...(['check_base','return_base','stow','retreat','leave_base','tunnel_out'].includes(kind)?{}:{item:goal.item,count:goal.count})}
  }

  if(kind==='construct'&&goal?.constructionLimits!==undefined){
    const c=goal.constructionLimits
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['materials','maxBlocks'].includes(k))||c.maxBlocks!==undefined&&(!Number.isInteger(c.maxBlocks)||c.maxBlocks<1||c.maxBlocks>2048)||c.materials!==undefined&&(!Array.isArray(c.materials)||c.materials.length>64||c.materials.some(n=>!/^[a-z0-9_]{1,64}$/.test(n))))throw new Error('Invalid construction limits')
  }
  if(['construct','build'].includes(kind)&&goal?.protectedSites!==undefined){
    if(!Array.isArray(goal.protectedSites)||goal.protectedSites.length>128)throw new Error('Invalid protected construction sites')
    for(const site of goal.protectedSites)if(!site||!['minX','maxX','minZ','maxZ'].every(k=>Number.isInteger(site[k])&&Math.abs(site[k])<=29999900)||site.minX>site.maxX||site.minZ>site.maxZ)throw new Error('Invalid protected construction rectangle')
  }
  if(kind==='construct'){if(goal?.previousDesign){if(!goal.origin)throw new Error('Revision requires its saved origin');architectureChanges(goal.previousDesign,goal.design)}if(!projectName(goal?.name))throw new Error('Invalid construction project name');return {name:goal.name,design:compileArchitecture(goal.design).design,...(goal.previousDesign?{previousDesign:compileArchitecture(goal.previousDesign).design}:{}),near:validateGoal(goal.near),...(goal.protectedSites?{protectedSites:structuredClone(goal.protectedSites)}:{}),...(goal.constructionLimits?{constructionLimits:structuredClone(goal.constructionLimits)}:{}),...(goal.origin?{origin:validateGoal(goal.origin)}:{})}}
  if(kind==='make_obsidian')return validateObsidianGoal(goal)
  if(kind==='prepare'&&toolName(goal?.item)&&Number.isInteger(goal.count)&&goal.count>=1&&goal.count<=4)return {item:goal.item,count:goal.count}
  if(kind==='give'&&/^[a-z0-9_]{1,64}$/.test(goal?.item||'')&&Number.isInteger(goal.count)&&goal.count>0&&goal.count<=64&&/^[A-Za-z0-9_]{1,16}$/.test(goal.player||''))return {item:goal.item,count:goal.count,player:goal.player}
  if (kind === 'acquire' && /^[a-z0-9_]{1,64}$/.test(goal?.item||'') && Number.isInteger(goal.count) && goal.count>0 && goal.count<=128)return {item:goal.item,count:goal.count}
  if (kind === 'build')return {...(goal?.purpose==='shelter'?{purpose:'shelter'}:{}),design:validateDesign(goal?.design),near:validateGoal(goal?.near),...(goal?.protectedSites?{protectedSites:structuredClone(goal.protectedSites)}:{}),...(goal?.origin?{origin:validateGoal(goal.origin)}:{}),...(goal?.wood&&isLog(goal.wood)?{wood:goal.wood}:{})}
  if (kind === 'navigate') return validateGoal(goal)
  if (kind === 'follow' && typeof goal?.player === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(goal.player)) return { player: goal.player }
  // A gather may dig toward a log it cannot walk to, so it carries the saved footprints it must not break.
  if (kind === 'gather' && validResource(goal?.item) && Number.isInteger(goal.count) && goal.count >= 1 && goal.count <= 32) { validateProtectedSites(goal.protectedSites); return { item: goal.item, count: goal.count, ...(goal.protectedSites?.length ? { protectedSites: goal.protectedSites } : {}) } }
  if (kind === 'craft' && goal?.item === 'wooden_pickaxe' && goal.count === 1) return { item: goal.item, count: 1 }
  throw new Error('Invalid skill goal; check action, item, count, coordinates and design')
}
export function saveTask(path, profile, task) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify({ schema: 1, profile, task }, null, 2) + '\n', { mode: 0o600 })
  renameSync(path + '.tmp', path)
}
export function loadTask(path, profile, now = Date.now()) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`Cannot load task state: ${error.message}`)
  }
  if (value.schema !== 1 || value.profile !== profile) throw new Error('task state belongs to a different profile or schema')
  const task = value.task
  if (task === null) return null
  if (!task || !statuses.has(task.status) || !Number.isFinite(task.deadline) || typeof task.id !== 'string') throw new Error('invalid task state')
  if (['idleMs', 'hardDeadline'].some(k => task[k] !== undefined && !Number.isFinite(task[k]))) throw new Error('invalid task state')
  validateTaskGoal(task.kind || 'navigate', task.goal)
  if (['running', 'paused'].includes(task.status) && task.deadline <= now) {
    task.status = 'failed'; task.reason = 'deadline expired while offline'
  }
  return task
}
