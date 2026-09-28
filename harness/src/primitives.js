import {scaffoldItems} from './scaffold.js'
// Thin movement/dig primitives the planner can compose when travel/climb refuse.
// goto walks to a point (optionally digging through harvestable blocks); dig
// opens a short 1-wide 2-high tunnel toward a cell. Fat skills stay owned by
// their modules; these only supply the verbs travel deliberately withholds.
import { setTimeout as delay } from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { fullCube } from './construction.js'
import { DoorAwareMovements, allowGroundBreaking, requireReachedGoal, TRAVERSAL_DIG_COST, lavaBeside } from './navigation.js'
import { lineObstruction, LEG_TIMEOUT_MS, CLOSED_PER_LEG } from './travel.js'

const { goals } = pathfinding
export const GOTO_RANGE = 2, GOTO_MAX = 64, DIG_REACH = 4.5, DIG_COUNT_MAX = 32, DIG_BLOCK_MS = 20000
export const LIQUID = new Set(['water', 'lava', 'bubble_column'])
export const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])
export const AIR = new Set(['air', 'cave_air', 'void_air'])
// Things a player would not want a tunnel through: workstations, storage,
// lights, beds, doors, signs and other placed fixtures. Entries starting with
// '_' match any block name ending with them. Obsidian is absent on purpose:
// the planner mines it.
export const PROTECTED_BLOCKS = new Set([
  'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'chest', 'trapped_chest', 'barrel',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'ladder',
  'bell', 'lectern', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'brewing_stand', 'beacon', 'spawner', 'end_portal_frame',
  '_bed', '_door', '_trapdoor', '_fence_gate', '_sign', '_wall_sign', '_hanging_sign', '_shulker_box',
])
const protectedBlock = name => !!name && (PROTECTED_BLOCKS.has(name)
  || [...PROTECTED_BLOCKS].some(s => s.startsWith('_') && name.endsWith(s)))
export const key = p => `${p.x},${p.y},${p.z}`
// The heuristic weight prospecting's excavation search uses.
const SEARCH_WEIGHT = 5
export const point = p => new Vec3(p.x, p.y, p.z)
const floored = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

export function validateProtectedSites(sites) {
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

export function inventoryCounts(bot) {
  const out = Object.create(null)
  for (const i of bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

export function inventoryDelta(before, after) {
  const drops = Object.create(null)
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] || 0) - (before[name] || 0)
    if (d > 0) drops[name] = d
  }
  return drops
}

// ITEM ids, not block ids: the pathfinder counts scaffold by item.type === id,
// and the two tables differ (dirt is block 9, item 28). With block ids it saw
// zero scaffold and could never tower, however much dirt was carried.
function scaffoldIds(bot) {
  return [...new Set(scaffoldItems(bot)
    .map(i => bot.registry.itemsByName[i.name]?.id ?? i.type)
    .filter(Number.isInteger))]
}

// `wade` lets the walk stand in water with air above it, as a player wades a
// flooded tunnel; ordinary walks keep treating water as a wall.
export function movementProfile(bot, { dig, protectedSites = [], wade = false }) {
  const movement = new DoorAwareMovements(bot, { shallowWaterOnly: wade })
  if (dig) {
    Object.assign(movement, {
      canDig: true, allow1by1towers: true, allowParkour: false, allowSprinting: false, maxDropDown: 3,
      scafoldingBlocks: scaffoldIds(bot),
      // Travel's price: at the default 1 the pathfinder tunnels through
      // anything rather than take a short detour.
      digCost: TRAVERSAL_DIG_COST,
    })
    // Pathfinder may break any harvestable block the tools can dig, except
    // liquids, falling overhead, fixtures, and saved project footprints.
    movement.exclusionAreasBreak.push(block => {
      if (!block?.position) return 100
      if (LIQUID.has(block.name) || GRAVITY.has(block.name) || protectedBlock(block.name)) return 100
      if (inProtectedSite(block.position, protectedSites)) return 100
      const above = bot.blockAt(block.position.offset(0, 1, 0))
      if (above && (LIQUID.has(above.name) || GRAVITY.has(above.name))) return 100
      // Judge the block, never the bot's reach: canDigBlock also tests distance,
      // which read every block past arm's length as unbreakable and left the
      // pathfinder no tunnel to plan. Bedrock and the like carry diggable:false.
      if (block.diggable === false && block.boundingBox === 'block') return 100
      return 0
    })
  } else {
    Object.assign(movement, { allow1by1towers: false, allowParkour: false, allowSprinting: false, scafoldingBlocks: [], maxDropDown: 3 })
    allowGroundBreaking(bot, movement)
    if (protectedSites.length)
      movement.exclusionAreasBreak.push(block => block?.position && inProtectedSite(block.position, protectedSites) ? 100 : 0)
  }
  if (protectedSites.length)
    movement.exclusionAreasPlace.push(block => block?.position && inProtectedSite(block.position, protectedSites) ? 100 : 0)
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

// A stuck leg is silent for its whole budget, but the pathfinder narrates it in
// its own events: what it last planned, and why it threw paths away.
export function watchPathfinder(bot) {
  let plans = 0, last = null, ticks = 0, corrections = 0, moved = 0, tickAt = null, correctedTo = null, packets = 0, relative = 0
  const ids = new Set()
  const resets = new Map()
  const onUpdate = r => { plans++; last = r }
  const onReset = reason => resets.set(reason, (resets.get(reason) || 0) + 1)
  // mineflayer skips physics before the server's first position, after respawn
  // or mount, and over an unloaded chunk; a leg with no ticks cannot move.
  const onTick = () => { ticks++; tickAt = bot.entity?.position?.clone?.() ?? null }
  // A server that disagrees with the client's world sends it back: forcedMove.
  // A few tenths each time is a refused move into what the server holds solid.
  const onForced = () => {
    corrections++
    const p = bot.entity?.position
    if (p && tickAt) moved += tickAt.distanceTo(p)
    correctedTo = p?.clone?.() ?? null
  }
  // The raw packets behind each correction: rising ids are new teleports, one
  // repeated id is a confirmation that never lands, relative flags are a rewrite.
  const onPacket = packet => {
    packets++; ids.add(packet?.teleportId)
    const f = packet?.flags
    if (typeof f === 'object' ? f?.x || f?.y || f?.z : f & 7) relative++
  }
  bot.on?.('path_update', onUpdate); bot.on?.('path_reset', onReset); bot.on?.('physicsTick', onTick); bot.on?.('forcedMove', onForced)
  bot._client?.on?.('position', onPacket)
  const body = () => {
    const e = bot.entity, v = e?.velocity, r = n => Math.round(n * 100) / 100
    const under = e?.position && bot.blockAt?.(e.position.offset(0, -1, 0))?.name
    const known = [...ids].filter(Number.isFinite)
    const raw = packets ? `; position packets ${packets}, teleport ids ${known.length ? `${Math.min(...known)}-${Math.max(...known)}` : 'unknown'} (${ids.size} distinct), ${relative} relative` : ''
    const shift = corrections && correctedTo ? `; corrections moved it ${r(moved / corrections)} on average, last to ${[correctedTo.x, correctedTo.y, correctedTo.z].map(r).join(',')}` : ''
    return ` Body: physics ticks ${ticks}; server corrections ${corrections}${raw}${shift}; onGround ${e?.onGround}, velocity ${v ? [v.x, v.y, v.z].map(r).join(',') : 'unknown'}, underfoot ${under ?? 'unknown'}.${corrections ? clientCells() : ''}`
  }
  // The solid cells the client believes touch or neighbour the body, nearest
  // first, so each can be checked against the server.
  const clientCells = () => {
    const p = bot.entity?.position
    if (!p || !bot.blockAt) return ''
    const cells = []
    for (let x = Math.floor(p.x - 0.7); x <= Math.floor(p.x + 0.7); x++)
      for (let z = Math.floor(p.z - 0.7); z <= Math.floor(p.z + 0.7); z++)
        for (let y = Math.floor(p.y) - 1; y <= Math.floor(p.y) + 2; y++) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (b?.boundingBox === 'block') cells.push({ x, y, z, name: b.name, d: Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z) })
        }
    cells.sort((a, b) => a.d - b.d)
    return cells.length ? ` client solid cells: ${cells.slice(0, 48).map(c => `${c.x},${c.y},${c.z} ${c.name}`).join('; ')}.` : ''
  }
  return {
    stop() { bot.off?.('path_update', onUpdate); bot.off?.('path_reset', onReset); bot.off?.('physicsTick', onTick); bot.off?.('forcedMove', onForced); bot._client?.off?.('position', onPacket) },
    summary() {
      if (!plans && !resets.size) return ' The pathfinder produced no plan in that time.' + body()
      const path = last?.path || [], sum = k => path.reduce((n, step) => n + (step[k]?.length || 0), 0)
      const plan = last ? `last plan ${path.length} steps, ${sum('toPlace')} places, ${sum('toBreak')} digs${last.status && last.status !== 'success' ? ` (${last.status})` : ''}` : 'no plan'
      const why = resets.size ? `; path reset ${[...resets].map(([r, n]) => `${r} x${n}`).join(', ')}` : ''
      return ` Pathfinder: ${plans} plan${plans === 1 ? '' : 's'}, ${plan}${why}.` + body()
    },
  }
}

export async function walkNear(bot, target, { dig, protectedSites, wade = false, check, stage, progress, movements, timeoutMs = 8 * 60 * 1000, range = GOTO_RANGE, legTimeoutMs = LEG_TIMEOUT_MS }) {
  const dest = point(target), start = bot.entity.position.clone()
  const distance = start.distanceTo(dest)
  if (distance > GOTO_MAX)
    throw new Error(`Goto refuses ${Math.round(distance)} blocks away (cap ${GOTO_MAX}). Use an intermediate goto closer to ${dest.x},${dest.y},${dest.z}.`)
  const movement = movementProfile(bot, { dig, protectedSites, wade })
  bot.pathfinder.setMovements(movement)
  const arrival = () => new goals.GoalNear(dest.x, dest.y, dest.z, range)
  const arrived = () => {
    const g = arrival(), f = bot.entity.position.floored()
    return g.isEnd(f) || g.isEnd(f.offset(0, 1, 0)) || bot.entity.position.distanceTo(dest) <= range
  }
  // Plain A* in dense rock with digging allowed runs out of its search time;
  // prospecting weights the heuristic fivefold and tunnels through the same
  // rock. The weighted goal keeps the same arrival test.
  let weighted = false
  const search = () => { const g = arrival(); if (!weighted) return g; const w = Object.create(g); w.heuristic = n => g.heuristic(n) * SEARCH_WEIGHT; return w }
  const counters = subscribeDigPlace(bot)
  const started = Date.now()
  const gap = () => bot.entity.position.distanceTo(dest)
  const short = () => `${Math.round(gap())} blocks short of ${key(dest)}.${lineRefusal(bot, bot.entity.position.floored(), dest)}`
  try {
    while (!arrived()) {
      check()
      if (Date.now() - started > timeoutMs) throw new Error(`Goto time limit reached ${short()}`)
      stage('walking'); progress(`Going to ${key(dest)}: ${Math.round(gap())} blocks to go`)
      // A leg is one bounded pathfinder call. One that runs out of time, or
      // resolves on a partial path, may still have closed ground: that walk
      // continues under timeoutMs, and only a leg that closed none refuses.
      const before = gap(), watch = watchPathfinder(bot)
      let expired = false, timer
      const expiry = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; bot.pathfinder.setGoal(null); reject(new Error('leg expired')) }, legTimeoutMs) })
      const walking = (async () => bot.pathfinder.goto(search()))()
      expiry.catch(() => {}); walking.catch(() => {})
      try {
        await Promise.race([walking, expiry])
        check(); requireReachedGoal(bot, arrival())
      } catch (error) {
        check()
        const closed = before - gap() >= CLOSED_PER_LEG
        if (!weighted && !closed && /Took to long to decide path/.test(error?.message || '')) { weighted = true; progress(`The route search ran out of time; searching again, weighted toward ${key(dest)}`); continue }
        if (expired && !closed)
          throw Object.assign(new Error(`Goto leg exceeded its ${Math.round(legTimeoutMs / 1000)} second budget without closing ground; ${short()}${watch.summary()}`), { name: 'Timeout' })
        if (!(closed && (expired || error?.code === 'NAVIGATION_INCOMPLETE'))) {
          const reason = error?.name === 'NoPath' ? `no route to ${key(dest)}` : error?.message || String(error)
          throw new Error(`${reason}.${lineRefusal(bot, bot.entity.position.floored(), dest)}`)
        }
      } finally { clearTimeout(timer); watch.stop(); bot.pathfinder.setGoal(null) }
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
  // The planner picks goto cells from what it has seen, and trial 21's last one
  // sat on a lava pool's edge. Standing beside lava is how a player catches fire,
  // so a planned destination keeps a cell clear, at feet and head height.
  const cell = new Vec3(goal.x, goal.y, goal.z)
  for (const q of [cell, cell.offset(0, 1, 0)]) {
    const lava = lavaBeside(bot, q)
    if (lava) throw new Error(`${key(cell)} is beside lava at ${key(lava)}; standing there is how the bot catches fire. Choose a cell at least two blocks from lava.`)
  }
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
  if (protectedBlock(block.name)) return `${block.name} at ${key(cell)} is a workstation or fixture; dig does not break those. Use revise for a saved build, or choose another cell.`
  if (AIR.has(block.name) || block.boundingBox === 'empty') return null // already open
  const above = bot.blockAt(cell.offset(0, 1, 0))
  if (above && LIQUID.has(above.name)) return `${key(cell)} directly supports liquid (${above.name}) at ${key(above.position || cell.offset(0, 1, 0))}`
  if (above && GRAVITY.has(above.name)) return `${key(cell)} directly supports falling ${above.name} above`
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = bot.blockAt(cell.offset(dx, 0, dz))
    if (side && LIQUID.has(side.name)) return `${key(cell)} borders ${side.name} at ${key(cell.offset(dx, 0, dz))}; digging it lets liquid in. Dig a different cell or block the ${side.name} first.`
  }
  // A cell the bot stands on or steps into (feet level or below, within one
  // column) becomes its floor's hole: what lies under it is where it lands.
  const feet = bot.entity?.position?.floored()
  if (feet && role !== 'head' && cell.y <= feet.y && (role === 'feet' || Math.max(Math.abs(cell.x - feet.x), Math.abs(cell.z - feet.z)) <= 1)) {
    const under = bot.blockAt(cell.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block' || LIQUID.has(under.name))
      return `${key(cell)} has no solid floor under it (${under?.name ?? 'unloaded'}); digging it opens a drop. Fill ${key(cell.offset(0, -1, 0))} first or dig a different cell.`
  }
  // Reach is the caller's to fix by walking; only an unbreakable block is refused here.
  if (block.diggable === false) return `${block.name} at ${key(cell)} cannot be broken`
  return null
}

async function digOne(bot, block, check) {
  if (!block || AIR.has(block.name) || block.boundingBox === 'empty') return { dug: false, harvestable: false }
  const harvestable = !block.harvestTools || Object.keys(block.harvestTools).length === 0
    || bot.inventory.items().some(i => Object.prototype.hasOwnProperty.call(block.harvestTools, String(i.type)) || Object.prototype.hasOwnProperty.call(block.harvestTools, i.type))
  if (bot.tool?.equipForBlock) await bot.tool.equipForBlock(block, { requireHarvest: false, getFromChest: false })
  // Jumping multiplies dig time by five. Let a completed walk land before
  // classifying the tool; never bypass the duration limit while airborne.
  if (bot.entity?.onGround === false) {
    for (let i = 0; i < 20 && bot.entity.onGround === false; i++) { check(); await delay(50) }
    check()
    if (bot.entity.onGround === false)
      throw Object.assign(new Error('Cannot dig while airborne; reach stable footing first'), { code: 'DIG_REFUSED' })
  }
  const at = key(block.position), ms = bot.digTime?.(block)
  if (ms > DIG_BLOCK_MS)
    throw Object.assign(new Error(`${block.name} at ${at} needs ${Math.round(ms / 1000)}s with ${bot.heldItem?.name ?? 'bare hands'}${harvestable ? '' : ' and drops nothing'}; get a better tool`), { code: 'DIG_REFUSED' })
  check(); await bot.dig(block); check()
  await delay(150)
  const after = bot.blockAt(block.position)
  if (after && after.name === block.name && !AIR.has(after.name))
    throw Object.assign(new Error(`the server restored ${block.name} at ${at} after digging it; the area may be protected, so dig somewhere else`), { code: 'DIG_REFUSED' })
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
    // canDigBlock measures from the eyes, so a cell below can be in reach of the feet and not the hand.
    if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > DIG_REACH || (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block))) {
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
        const refuse = refuseDigCell(bot, cell, { protectedSites: sites, role: cell === head ? 'head' : 'feet' })
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
        let result
        try { result = await digOne(bot, live, check) }
        catch (error) {
          if (error?.code !== 'DIG_REFUSED') throw error
          failOrStop(error.message, cell); dugThis = -1; break
        }
        if (result.dug) { dugThis++; lastHarvestable = result.harvestable }
      }
      if (dugThis < 0 || reason) break
      broken++
      // Step into the cleared column so the next cell is in reach. With the dig
      // profile: an upward line is a chimney, and only a profile that carries
      // scaffold and may tower one block can follow it. Without this the digger
      // cuts a shaft it cannot climb and every later goto times out beneath it.
      if (i < goal.count || bot.entity.position.floored().distanceTo(feet) > 0.1) {
        try {
          await walkNear(bot, feet, { dig: true, protectedSites: sites, check, stage, progress, movements, timeoutMs: 30000, range: 0 })
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
