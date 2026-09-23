// Thin movement/dig primitives the planner can compose when travel/climb refuse.
// goto walks to a point (optionally digging through harvestable blocks); dig
// opens a short 1-wide 2-high tunnel toward a cell. Fat skills stay owned by
// their modules; these only supply the verbs travel deliberately withholds.
import { setTimeout as delay } from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { fullCube } from './construction.js'
import { DoorAwareMovements, allowGroundBreaking, requireReachedGoal } from './navigation.js'
import { lineObstruction, LEG_TIMEOUT_MS } from './travel.js'

const { goals } = pathfinding
export const GOTO_RANGE = 2, GOTO_MAX = 64, DIG_REACH = 4.5, DIG_COUNT_MAX = 32
const LIQUID = new Set(['water', 'lava', 'bubble_column'])
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const key = p => `${p.x},${p.y},${p.z}`
const point = p => new Vec3(p.x, p.y, p.z)
const floored = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

function validateProtectedSites(sites) {
  if (sites === undefined) return
  if (!Array.isArray(sites) || sites.length > 128) throw new Error('Invalid protected construction sites')
  for (const site of sites)
    if (!site || !['minX', 'maxX', 'minZ', 'maxZ'].every(k => Number.isInteger(site[k]) && Math.abs(site[k]) <= 29999900) || site.minX > site.maxX || site.minZ > site.maxZ)
      throw new Error('Invalid protected construction rectangle')
}

export function inProtectedSite(p, sites = []) {
  return sites.some(s => p.x >= s.minX && p.x <= s.maxX && p.z >= s.minZ && p.z <= s.maxZ)
}

export function validateGotoGoal(goal) {
  if (!goal || !['x', 'y', 'z'].every(k => Number.isSafeInteger(goal[k])) || typeof goal.dig !== 'boolean')
    throw new Error('Goto needs integer x, y, z and a boolean dig')
  validateProtectedSites(goal.protectedSites)
  return { x: goal.x, y: goal.y, z: goal.z, dig: goal.dig, ...(goal.protectedSites?.length ? { protectedSites: goal.protectedSites } : {}) }
}

export function validateDigGoal(goal) {
  if (!goal || !['x', 'y', 'z'].every(k => Number.isSafeInteger(goal[k])))
    throw new Error('Dig needs a target with integer x, y and z')
  if (!Number.isInteger(goal.count) || goal.count < 1 || goal.count > DIG_COUNT_MAX)
    throw new Error(`Dig count must be 1–${DIG_COUNT_MAX}`)
  validateProtectedSites(goal.protectedSites)
  return { x: goal.x, y: goal.y, z: goal.z, count: goal.count, ...(goal.protectedSites?.length ? { protectedSites: goal.protectedSites } : {}) }
}

export function validateGotoStep(s) {
  if (s.count !== 0 || s.name !== '' || (s.item ?? '') !== '' || (s.design !== undefined && (!Array.isArray(s.design) || s.design.length)))
    throw new Error('Terrain recovery requires empty name, item, design and count zero')
  if (!s.target || typeof s.target.dig !== 'boolean' || Object.keys(s.target).length !== 4 || !['x', 'y', 'z'].every(k => Number.isSafeInteger(s.target[k])))
    throw new Error('Goto needs a target with integer x, y, z and a boolean dig')
}

export function validateDigStep(s) {
  if (s.name !== '' || (s.item ?? '') !== '' || (s.design !== undefined && (!Array.isArray(s.design) || s.design.length)))
    throw new Error('Dig requires empty name, item and design')
  if (!Number.isInteger(s.count) || s.count < 1 || s.count > DIG_COUNT_MAX)
    throw new Error(`Dig count must be 1–${DIG_COUNT_MAX}`)
  if (!s.target || Object.keys(s.target).length !== 3 || !['x', 'y', 'z'].every(k => Number.isSafeInteger(s.target[k])))
    throw new Error('Dig needs a target with integer x, y and z')
}

function inventoryCounts(bot) {
  const out = Object.create(null)
  for (const i of bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

function inventoryDelta(before, after) {
  const drops = Object.create(null)
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] || 0) - (before[name] || 0)
    if (d > 0) drops[name] = d
  }
  return drops
}

function scaffoldIds(bot) {
  return [...new Set(bot.inventory.items()
    .filter(i => fullCube(bot.registry, i.name) && !GRAVITY.has(i.name))
    .map(i => bot.registry.blocksByName[i.name]?.id)
    .filter(Number.isInteger))]
}

function movementProfile(bot, { dig, protectedSites = [] }) {
  const movement = new DoorAwareMovements(bot)
  if (dig) {
    Object.assign(movement, {
      canDig: true, allow1by1towers: true, allowParkour: false, allowSprinting: false, maxDropDown: 3,
      scafoldingBlocks: scaffoldIds(bot),
    })
    // Pathfinder may break any harvestable block the tools can dig, except
    // liquids, falling overhead, and saved project footprints.
    movement.exclusionAreasBreak.push(block => {
      if (!block?.position) return 100
      if (LIQUID.has(block.name) || GRAVITY.has(block.name)) return 100
      if (inProtectedSite(block.position, protectedSites)) return 100
      const above = bot.blockAt(block.position.offset(0, 1, 0))
      if (above && (LIQUID.has(above.name) || GRAVITY.has(above.name))) return 100
      if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block) && block.boundingBox === 'block') return 100
      return 0
    })
  } else {
    Object.assign(movement, { allow1by1towers: false, allowParkour: false, allowSprinting: false, scafoldingBlocks: [], maxDropDown: 3 })
    allowGroundBreaking(bot, movement)
    if (protectedSites.length)
      movement.exclusionAreasBreak.push(block => block?.position && inProtectedSite(block.position, protectedSites) ? 100 : 0)
  }
  return movement
}

function lineRefusal(bot, from, to) {
  const blocked = lineObstruction(bot, from, to)
  if (!blocked) return ' The straight line is clear, so whatever refused the route is above, below or beside it.'
  return ` The straight line runs into ${blocked.name} ${blocked.away} blocks ahead.`
}

function subscribeDigPlace(bot) {
  let dug = 0, placed = 0, countsFrom = 'events'
  const onDig = () => { dug++ }
  const onPlace = () => { placed++ }
  bot.on?.('diggingCompleted', onDig)
  bot.on?.('blockPlaced', onPlace)
  const before = inventoryCounts(bot)
  return {
    finish() {
      bot.off?.('diggingCompleted', onDig)
      bot.off?.('blockPlaced', onPlace)
      // Event counters stay primary; inventory delta is only a fallback when the
      // stub (or a missed packet) never emitted diggingCompleted/blockPlaced.
      if (dug === 0 && placed === 0) {
        const after = inventoryCounts(bot)
        const spent = Object.create(null)
        for (const name of Object.keys(before)) {
          const d = (before[name] || 0) - (after[name] || 0)
          if (d > 0 && fullCube(bot.registry, name)) spent[name] = d
        }
        const gainedPick = Object.keys(inventoryDelta(before, after)).length
        if (Object.keys(spent).length || gainedPick) {
          placed = Object.values(spent).reduce((n, v) => n + v, 0)
          countsFrom = 'inventory_delta'
        }
      }
      return { dug, placed, countsFrom }
    },
  }
}

export async function walkNear(bot, target, { dig, protectedSites, check, stage, progress, movements, timeoutMs = 8 * 60 * 1000 }) {
  const dest = point(target), start = bot.entity.position.clone()
  const distance = start.distanceTo(dest)
  if (distance > GOTO_MAX)
    throw new Error(`Goto refuses ${Math.round(distance)} blocks away (cap ${GOTO_MAX}). Use an intermediate goto closer to ${dest.x},${dest.y},${dest.z}.`)
  const movement = movementProfile(bot, { dig, protectedSites })
  bot.pathfinder.setMovements(movement)
  const arrival = () => new goals.GoalNear(dest.x, dest.y, dest.z, GOTO_RANGE)
  const arrived = () => {
    const g = arrival(), f = bot.entity.position.floored()
    return g.isEnd(f) || g.isEnd(f.offset(0, 1, 0)) || bot.entity.position.distanceTo(dest) <= GOTO_RANGE
  }
  const counters = subscribeDigPlace(bot)
  const started = Date.now()
  try {
    while (!arrived()) {
      check()
      if (Date.now() - started > timeoutMs)
        throw new Error(`Goto time limit reached ${Math.round(bot.entity.position.distanceTo(dest))} blocks short of ${key(dest)}.${lineRefusal(bot, bot.entity.position.floored(), dest)}`)
      stage('walking'); progress(`Going to ${key(dest)}: ${Math.round(bot.entity.position.distanceTo(dest))} blocks to go`)
      let expired = false
      const timer = setTimeout(() => { expired = true; bot.pathfinder.setGoal(null) }, LEG_TIMEOUT_MS)
      try {
        await bot.pathfinder.goto(arrival())
        check(); requireReachedGoal(bot, arrival())
      } catch (error) {
        if (expired) throw Object.assign(new Error(`Goto leg exceeded its ${Math.round(LEG_TIMEOUT_MS / 1000)} second budget`), { name: 'Timeout' })
        const reason = error?.name === 'NoPath' ? `no route to ${key(dest)}` : error?.message || String(error)
        throw new Error(`${reason}.${lineRefusal(bot, bot.entity.position.floored(), dest)}`)
      } finally { clearTimeout(timer); bot.pathfinder.setGoal(null) }
      check()
      if (!arrived()) await delay(50)
    }
    check(); requireReachedGoal(bot, arrival())
  } finally {
    bot.pathfinder.setGoal(null); bot.clearControlStates?.()
    if (movements) bot.pathfinder.setMovements(movements)
  }
  const counts = counters.finish()
  const p = bot.entity.position
  return {
    receipt: 'arrived',
    from: floored(start),
    to: { x: dest.x, y: dest.y, z: dest.z },
    distance: Math.round(start.distanceTo(p) * 10) / 10,
    dug: counts.dug,
    placed: counts.placed,
    countsFrom: counts.countsFrom,
  }
}

export async function gotoPosition(bot, task, { check, stage, progress, movements }) {
  const goal = validateGotoGoal(task.goal)
  return walkNear(bot, goal, { dig: goal.dig, protectedSites: goal.protectedSites || [], check, stage, progress, movements })
}

function refuseDigCell(bot, cell, { protectedSites = [], role = 'target' } = {}) {
  const block = bot.blockAt(cell)
  if (!block) {
    const here = bot.entity?.position
    const away = here ? Math.round(here.distanceTo(cell)) : null
    return away == null
      ? `${key(cell)} is not loaded; travel closer and re-observe.`
      : `${key(cell)} is not loaded (${away} blocks away). Travel closer and re-observe.`
  }
  if (LIQUID.has(block.name)) return `${role} is liquid (${block.name}) at ${key(cell)}`
  if (inProtectedSite(cell, protectedSites)) return `${key(cell)} is inside a saved project footprint; dig does not modify saved builds. Choose a cell outside it, or revise the project.`
  if (AIR.has(block.name) || block.boundingBox === 'empty') return null // already open
  const above = bot.blockAt(cell.offset(0, 1, 0))
  if (above && LIQUID.has(above.name)) return `${key(cell)} directly supports liquid (${above.name}) at ${key(above.position || cell.offset(0, 1, 0))}`
  if (above && GRAVITY.has(above.name)) return `${key(cell)} directly supports falling ${above.name} above`
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block) && bot.entity.position.distanceTo(cell.offset(0.5, 0.5, 0.5)) <= DIG_REACH + 0.5)
    return `Cannot dig ${block.name} at ${key(cell)} with carried tools from here`
  return null
}

async function digOne(bot, block, check) {
  if (!block || AIR.has(block.name) || block.boundingBox === 'empty') return { dug: false, harvestable: false }
  const harvestable = !block.harvestTools || Object.keys(block.harvestTools).length === 0
    || bot.inventory.items().some(i => Object.prototype.hasOwnProperty.call(block.harvestTools, String(i.type)) || Object.prototype.hasOwnProperty.call(block.harvestTools, i.type))
  if (bot.tool?.equipForBlock) await bot.tool.equipForBlock(block, { requireHarvest: false, getFromChest: false })
  check(); await bot.dig(block); check()
  return { dug: true, harvestable }
}

function stepToward(from, to, index) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const len = Math.hypot(dx, dy, dz) || 1
  const t = Math.min(1, index / Math.max(1, Math.round(len)))
  return new Vec3(
    Math.round(from.x + dx * t),
    Math.round(from.y + dy * t),
    Math.round(from.z + dz * t),
  )
}

export async function digToward(bot, task, context) {
  const { check, stage, progress, movements } = context
  const goal = validateDigGoal(task.goal)
  const target = point(goal), sites = goal.protectedSites || []
  const before = inventoryCounts(bot)
  let broken = 0, stoppedAt = null, reason = null, lastHarvestable = null

  const failOrStop = (msg, at) => {
    if (broken === 0) throw new Error(msg)
    reason = msg; stoppedAt = at ? { x: at.x, y: at.y, z: at.z } : null
  }

  // Single-block dig: the named target only.
  if (goal.count === 1) {
    const refusal = refuseDigCell(bot, target, { protectedSites: sites })
    if (refusal) throw new Error(refusal)
    const block = bot.blockAt(target)
    if (!block || AIR.has(block.name) || block.boundingBox === 'empty')
      throw new Error(`Nothing to dig at ${key(target)}; the cell is already open`)
    if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > DIG_REACH) {
      stage('walking'); progress(`Walking within reach of ${key(target)}`)
      await walkNear(bot, target, { dig: false, protectedSites: sites, check, stage, progress, movements, timeoutMs: 60000 })
      check()
    }
    const still = refuseDigCell(bot, target, { protectedSites: sites })
    if (still) throw new Error(still)
    const live = bot.blockAt(target)
    if (!live || AIR.has(live.name)) throw new Error(`Nothing to dig at ${key(target)}; the cell is already open`)
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(live))
      throw new Error(`Cannot reach ${live.name} at ${key(target)} to dig it; walk closer`)
    stage('digging'); progress(`Digging ${live.name} at ${key(target)}`)
    const result = await digOne(bot, live, check)
    if (!result.dug) throw new Error(`Failed to dig ${key(target)}`)
    broken = 1; lastHarvestable = result.harvestable
  } else {
    // Tunnel: each count unit is one column along the straight line (feet + head).
    const start = bot.entity.position.floored()
    for (let i = 1; i <= goal.count; i++) {
      check()
      const feet = stepToward(start, target, i)
      const head = feet.offset(0, 1, 0)
      const feetRefuse = refuseDigCell(bot, feet, { protectedSites: sites, role: 'feet' })
      if (feetRefuse) { failOrStop(feetRefuse, feet); break }
      const headBlock = bot.blockAt(head)
      if (headBlock && LIQUID.has(headBlock.name)) { failOrStop(`head is liquid (${headBlock.name}) at ${key(head)}`, feet); break }
      if (headBlock && inProtectedSite(head, sites)) { failOrStop(`${key(head)} is inside a saved project footprint; dig does not modify saved builds.`, feet); break }
      const aboveHead = bot.blockAt(head.offset(0, 1, 0))
      if (aboveHead && (LIQUID.has(aboveHead.name) || GRAVITY.has(aboveHead.name))) {
        failOrStop(`${key(head)} directly supports ${aboveHead.name} above`, feet); break
      }
      // Approach the column without digging through stone if we are not yet adjacent.
      if (bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) > DIG_REACH) {
        stage('walking'); progress(`Approaching tunnel column ${key(feet)}`)
        try {
          await walkNear(bot, feet, { dig: false, protectedSites: sites, check, stage, progress, movements, timeoutMs: 60000 })
        } catch (error) {
          failOrStop(error.message, feet); break
        }
        check()
      }
      stage('digging'); progress(`Tunnel step ${i}/${goal.count} at ${key(feet)}`)
      let dugThis = 0
      for (const cell of [feet, head]) {
        const b = bot.blockAt(cell)
        if (!b || AIR.has(b.name) || b.boundingBox === 'empty') continue
        const refuse = refuseDigCell(bot, cell, { protectedSites: sites })
        if (refuse) { failOrStop(refuse, cell); dugThis = -1; break }
        if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(b)) {
          // Step adjacent once more, then recheck.
          try {
            await walkNear(bot, cell, { dig: false, protectedSites: sites, check, stage, progress, movements, timeoutMs: 30000 })
          } catch (error) {
            failOrStop(error.message, cell); dugThis = -1; break
          }
        }
        const live = bot.blockAt(cell)
        if (!live || AIR.has(live.name) || live.boundingBox === 'empty') continue
        if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(live)) {
          failOrStop(`Cannot reach ${live.name} at ${key(cell)} to dig it`, cell); dugThis = -1; break
        }
        const result = await digOne(bot, live, check)
        if (result.dug) { dugThis++; lastHarvestable = result.harvestable }
      }
      if (dugThis < 0 || reason) break
      broken++
      // Step into the cleared column so the next cell is in reach.
      if (i < goal.count || bot.entity.position.floored().distanceTo(feet) > 0.1) {
        try {
          await walkNear(bot, feet, { dig: false, protectedSites: sites, check, stage, progress, movements, timeoutMs: 30000 })
        } catch (error) {
          // Column is open; standing short is not a dig failure if we already broke it.
          progress(`Could not step into ${key(feet)}: ${error.message}`)
        }
      }
    }
    if (broken === 0) throw new Error(reason || `Dig broke nothing toward ${key(target)}`)
  }

  const drops = inventoryDelta(before, inventoryCounts(bot))
  return {
    receipt: 'dug',
    broken,
    requested: goal.count,
    stoppedAt: broken < goal.count ? (stoppedAt || { x: target.x, y: target.y, z: target.z }) : null,
    reason: broken < goal.count ? reason : null,
    drops,
    ...(lastHarvestable !== null ? { harvestable: lastHarvestable } : {}),
  }
}
