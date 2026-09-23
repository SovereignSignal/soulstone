// Thin world primitives beside goto and dig: place one carried full cube at a
// named cell, and pick up dropped items lying nearby. Fat skills (build,
// construct, place, hunt, gather) keep their site, orientation and lighting
// checks; these supply the two verbs the planner otherwise cannot express.
import { setTimeout as delay } from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { fullCube } from './construction.js'
import { DoorAwareMovements } from './navigation.js'
import { weaponFor, clearStrike } from './combat.js'
import { walkNear, inProtectedSite, inventoryCounts, inventoryDelta, LIQUID, AIR, DIG_REACH, key, point } from './primitives.js'

const { goals } = pathfinding
export const PLACE_REACH = DIG_REACH, COLLECT_RADIUS = 16, COLLECT_MAX = 64
export const ATTACK_RADIUS = 24, ATTACK_REACH = 3.2, ATTACK_MS = 90000, ATTACK_LEASH = 32, ATTACK_HEALTH_START = 8, ATTACK_HEALTH_STOP = 6, ATTACK_FOOD_START = 6, REACQUIRE_RADIUS = 8
const ITEM_ID = /^[a-z0-9_]{1,64}$/
const ENTITY_TYPE = /^[a-z_]{1,40}$/
// Cells the server treats as replaceable by a placement.
const REPLACEABLE = new Set([...AIR, 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'seagrass', 'tall_seagrass', 'fire', 'light'])
const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function validateProtectedSites(sites) {
  if (sites === undefined) return
  if (!Array.isArray(sites) || sites.length > 128) throw new Error('Invalid protected construction sites')
  for (const site of sites)
    if (!site || !['minX', 'maxX', 'minZ', 'maxZ'].every(k => Number.isInteger(site[k]) && Math.abs(site[k]) <= 29999900) || site.minX > site.maxX || site.minZ > site.maxZ)
      throw new Error('Invalid protected construction rectangle')
}

export function validatePlaceAtGoal(goal) {
  if (!goal || !['x', 'y', 'z'].every(k => Number.isSafeInteger(goal[k]))) throw new Error('Place_at needs a target with integer x, y and z')
  if (!ITEM_ID.test(goal.item || '')) throw new Error('Place_at needs a carried block item ID')
  validateProtectedSites(goal.protectedSites)
  return { item: goal.item, x: goal.x, y: goal.y, z: goal.z, ...(goal.protectedSites?.length ? { protectedSites: goal.protectedSites } : {}) }
}

export function validateCollectGoal(goal) {
  if (!goal || !Number.isInteger(goal.count) || goal.count < 1 || goal.count > COLLECT_MAX) throw new Error(`Collect count must be 1–${COLLECT_MAX}`)
  const item = goal.item || ''
  if (item !== '' && !ITEM_ID.test(item)) throw new Error('Collect item must be an item ID or empty for anything')
  return { item, count: goal.count }
}

export function validateAttackGoal(goal) {
  if (!goal || !ENTITY_TYPE.test(goal.type || '')) throw new Error('Attack needs an entity type name such as zombie, cow or enderman')
  if (goal.type === 'player') throw new Error('attack never targets players')
  return { type: goal.type }
}

export function validateAttackStep(s) {
  if (s.name !== '' || s.count !== 1 || (s.design !== undefined && (!Array.isArray(s.design) || s.design.length)) || s.target != null)
    throw new Error('Attack requires empty name and design, count 1 and no target')
  validateAttackGoal({ type: s.item })
}

export function validatePlaceAtStep(s) {
  if (s.name !== '' || s.count !== 1 || (s.design !== undefined && (!Array.isArray(s.design) || s.design.length)))
    throw new Error('Place_at requires empty name and design and count 1')
  if (!ITEM_ID.test(s.item || '')) throw new Error('Place_at needs a carried block item ID')
  if (!s.target || Object.keys(s.target).length !== 3 || !['x', 'y', 'z'].every(k => Number.isSafeInteger(s.target[k])))
    throw new Error('Place_at needs a target with integer x, y and z')
}

export function validateCollectStep(s) {
  if (s.name !== '' || (s.design !== undefined && (!Array.isArray(s.design) || s.design.length)) || s.target != null)
    throw new Error('Collect requires empty name and design and no target')
  if (!Number.isInteger(s.count) || s.count < 1 || s.count > COLLECT_MAX) throw new Error(`Collect count must be 1–${COLLECT_MAX}`)
  if ((s.item ?? '') !== '' && !ITEM_ID.test(s.item)) throw new Error('Collect item must be an item ID or empty for anything')
}

const isSolid = b => !!b && b.boundingBox === 'block' && !AIR.has(b.name)
const replaceable = b => !!b && (REPLACEABLE.has(b.name) || b.boundingBox === 'empty' && !LIQUID.has(b.name))

// Cells the bot's own body occupies: the server refuses a block inside a player.
function occupiedByBot(bot, cell) {
  const p = bot.entity.position
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return cell.equals(feet) || cell.equals(feet.offset(0, 1, 0))
}

function occupantAt(bot, cell) {
  const centre = cell.offset(0.5, 0.5, 0.5)
  return Object.values(bot.entities || {}).find(e => e && e !== bot.entity && e.position && !e.getDroppedItem?.() && e.position.distanceTo(centre) < 0.9)
}

export async function placeAt(bot, task, { check, stage, progress, movements }) {
  const goal = validatePlaceAtGoal(task.goal)
  const target = point(goal), sites = goal.protectedSites || []
  const carried = bot.inventory.items().find(i => i.name === goal.item)
  if (!carried) throw new Error(`Not carrying ${goal.item}; acquire it first`)
  if (!fullCube(bot.registry, goal.item))
    throw new Error(`${goal.item} is not a full cube; build, construct and place own doors, beds, stairs, torches and workstations`)
  if (inProtectedSite(target, sites))
    throw new Error(`${key(target)} is inside a saved project footprint; place_at does not modify saved builds. Use construct or revise for that project.`)
  const readTarget = () => {
    const block = bot.blockAt(target)
    if (!block) {
      const away = Math.round(bot.entity.position.distanceTo(target))
      throw new Error(`${key(target)} is not loaded (${away} blocks away). Travel closer and re-observe.`)
    }
    if (!replaceable(block)) throw new Error(`${key(target)} already holds ${block.name}; choose an empty cell or dig it first`)
    return block
  }
  readTarget()
  const support = () => {
    for (const face of FACES) {
      const n = target.plus(face), b = bot.blockAt(n)
      if (isSolid(b) && !occupiedByBot(bot, n)) return { reference: b, faceVector: face.scaled(-1), against: n }
    }
    return null
  }
  if (!support())
    throw new Error(`No solid face touches ${key(target)}; place a support block beside or below it first, or choose a cell touching solid ground`)
  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > PLACE_REACH) {
    stage('walking'); progress(`Walking within reach of ${key(target)}`)
    await walkNear(bot, target, { dig: false, protectedSites: sites, check, stage, progress, movements, timeoutMs: 60000 })
    check()
  }
  if (occupiedByBot(bot, target)) {
    // A walk within reach may end standing in the cell itself. Step onto a
    // neighbouring standable cell rather than refusing the planner's own target.
    const aside = FACES.filter(f => f.y === 0).map(f => target.plus(f))
      .find(n => replaceable(bot.blockAt(n)) && replaceable(bot.blockAt(n.offset(0, 1, 0))) && isSolid(bot.blockAt(n.offset(0, -1, 0))))
    if (!aside) throw new Error(`Standing in ${key(target)} with no open cell beside it to step onto; move first, then place`)
    stage('walking'); progress(`Stepping aside to ${key(aside)} before placing at ${key(target)}`)
    await bot.pathfinder.goto(new goals.GoalBlock(aside.x, aside.y, aside.z)); check()
    if (occupiedByBot(bot, target)) throw new Error(`Still standing in ${key(target)} after stepping aside; move first, then place`)
  }
  const occupant = occupantAt(bot, target)
  if (occupant) throw new Error(`${occupant.name || occupant.type || 'an entity'} is standing in ${key(target)}; wait for it to move or choose another cell`)
  readTarget()
  const chosen = support()
  if (!chosen) throw new Error(`No solid face touches ${key(target)} from here; place a support block first`)
  stage('placing'); progress(`Placing ${goal.item} at ${key(target)} against ${key(chosen.against)}`)
  check()
  const before = inventoryCounts(bot)
  await bot.equip(carried, 'hand'); check()
  await bot.lookAt?.(target.offset(0.5, 0.5, 0.5), true)
  try { await bot.placeBlock(chosen.reference, chosen.faceVector) }
  catch (error) { throw new Error(`Placement of ${goal.item} at ${key(target)} was refused: ${error.message}`) }
  check()
  await delay(60)
  const after = bot.blockAt(target)
  const spent = (before[goal.item] || 0) - (inventoryCounts(bot)[goal.item] || 0)
  if (!after || after.name !== goal.item)
    throw new Error(`Placed nothing observable at ${key(target)}: the cell reads ${after?.name ?? 'unloaded'} and ${spent > 0 ? `${spent} ${goal.item} left the inventory` : 'nothing was spent'}`)
  return { receipt: 'placed', block: goal.item, at: { x: target.x, y: target.y, z: target.z }, against: { x: chosen.against.x, y: chosen.against.y, z: chosen.against.z }, spent }
}

function dropsNear(bot, item, radius = COLLECT_RADIUS) {
  const here = bot.entity.position
  return Object.values(bot.entities || {})
    .map(e => ({ entity: e, stack: e?.getDroppedItem?.() }))
    .filter(({ entity, stack }) => stack && entity.position && entity.position.distanceTo(here) <= radius && (!item || stack.name === item))
    .map(({ entity, stack }) => ({ id: entity.id, name: stack.name, count: stack.count || 1, position: entity.position, d: Math.round(entity.position.distanceTo(here) * 10) / 10 }))
    .sort((a, b) => a.d - b.d)
}

const gainedOf = (before, after, item) => {
  const delta = inventoryDelta(before, after)
  return item ? delta[item] || 0 : Object.values(delta).reduce((n, v) => n + v, 0)
}

export async function collectDrops(bot, task, { check, stage, progress, movements }) {
  const goal = validateCollectGoal(task.goal)
  const label = goal.item || 'any item'
  const before = inventoryCounts(bot)
  const seen = dropsNear(bot, goal.item)
  if (!seen.length) {
    const others = dropsNear(bot, '').slice(0, 3).map(d => `${d.count} ${d.name} at ${key(d.position.floored())}`)
    throw new Error(`No dropped ${label} within ${COLLECT_RADIUS} blocks${others.length ? `; other drops: ${others.join(', ')}` : ''}`)
  }
  const tried = new Set()
  let gained = 0, walked = 0
  for (;;) {
    check()
    gained = gainedOf(before, inventoryCounts(bot), goal.item)
    if (gained >= goal.count) break
    const next = dropsNear(bot, goal.item).find(d => !tried.has(d.id))
    if (!next) break
    tried.add(next.id)
    stage('walking'); progress(`Collecting ${next.count} ${next.name} ${next.d} blocks away (${gained}/${goal.count} ${label} so far)`)
    try {
      await walkNear(bot, next.position.floored(), { dig: false, protectedSites: [], check, stage, progress, movements, timeoutMs: 45000 })
      walked++
    } catch (error) {
      progress(`Could not reach the ${next.name} at ${key(next.position.floored())}: ${error.message}`)
      continue
    }
    // Pickup is server-side and lands a few ticks after arrival.
    for (let i = 0; i < 12 && gainedOf(before, inventoryCounts(bot), goal.item) === gained; i++) { check(); await delay(100) }
  }
  gained = gainedOf(before, inventoryCounts(bot), goal.item)
  const remaining = dropsNear(bot, goal.item).length
  if (gained === 0) {
    const nearest = seen[0]
    throw new Error(`Collected nothing: saw ${seen.length} ${label} drop${seen.length === 1 ? '' : 's'}, nearest ${nearest.count} ${nearest.name} at ${key(nearest.position.floored())}, walked to ${walked}; check for a full inventory or an unreachable ledge`)
  }
  return { receipt: 'collected', item: goal.item, gained, requested: goal.count, remainingDrops: remaining, partial: gained < goal.count }
}

const knownPoint = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const nearestOfType = (bot, type, from, radius) => Object.values(bot.entities || {})
  .filter(e => e && e !== bot.entity && e.name === type && e.type !== 'player' && knownPoint(e.position) && e.position.distanceTo(from) <= radius)
  .sort((a, b) => a.position.distanceTo(from) - b.position.distanceTo(from))[0]

// Planner-directed melee against the nearest entity of a named type. The
// automatic defend path keeps its own allow-list and margins; this is the verb
// a plan reaches for (a cow for leather, an enderman for a pearl, a blaze for a
// rod). Verification is the server's entityDead for the entity we struck.
export async function attackEntity(bot, task, { check, stage, progress, movements }) {
  const goal = validateAttackGoal(task.goal)
  const here = bot.entity.position
  if (!(bot.health >= ATTACK_HEALTH_START)) throw new Error(`Health ${Math.round(bot.health)} is below ${ATTACK_HEALTH_START}; eat or shelter before attacking`)
  if (!(bot.food >= ATTACK_FOOD_START)) throw new Error(`Hunger ${bot.food} is below ${ATTACK_FOOD_START}; eat before attacking`)
  let target = nearestOfType(bot, goal.type, here, ATTACK_RADIUS)
  if (!target) {
    const others = Object.values(bot.entities || {})
      .filter(e => e && e !== bot.entity && e.name && e.type !== 'player' && !e.getDroppedItem?.() && knownPoint(e.position) && e.position.distanceTo(here) <= ATTACK_RADIUS)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here)).slice(0, 3)
      .map(e => `${e.name} ${Math.round(e.position.distanceTo(here))}`)
    throw new Error(`No ${goal.type} within ${ATTACK_RADIUS} blocks${others.length ? `; nearest loaded entities: ${others.join(', ')}` : ''}`)
  }
  const weapon = weaponFor(bot, target) || null
  const cooldown = weapon ? (weapon.name.endsWith('_axe') ? 1300 : 700) : 500
  const before = inventoryCounts(bot), start = here.clone(), started = Date.now()
  let swings = 0, reacquired = 0, dead = false, lastSeen = target.position.clone()
  const killed = e => { if (e && e.id === target.id) dead = true }
  bot.on('entityDead', killed)
  const movement = new DoorAwareMovements(bot)
  Object.assign(movement, { canDig: false, allow1by1towers: false, allowParkour: false, allowSprinting: true, maxDropDown: 2, scafoldingBlocks: [] })
  let following = false, nextSwing = 0
  const strikeable = () => bot.entity.position.distanceTo(target.position) <= ATTACK_REACH && (typeof bot.world?.raycast !== 'function' || clearStrike(bot, target))
  try {
    stage('arming')
    if (weapon) await bot.equip(weapon, 'hand')
    check()
    bot.pathfinder.setMovements(movement)
    stage('attacking'); progress(`Attacking the nearest ${goal.type} ${Math.round(target.position.distanceTo(here))} blocks away with ${weapon ? weapon.name.replaceAll('_', ' ') : 'fists'}`)
    for (;;) {
      check()
      if (dead) break
      const elapsed = Date.now() - started
      if (bot.health < ATTACK_HEALTH_STOP) throw new Error(`Health ${Math.round(bot.health)}: broke off the attack on the ${goal.type} after ${swings} swings; shelter or eat`)
      if (elapsed >= ATTACK_MS) throw new Error(`Gave up after ${Math.round(elapsed / 1000)}s: ${goal.type} last seen ${Math.round(lastSeen.distanceTo(bot.entity.position))} blocks away, ${swings} swings landed, health ${Math.round(bot.health)}`)
      if (bot.entity.position.distanceTo(start) > ATTACK_LEASH) throw new Error(`The ${goal.type} led the chase ${Math.round(bot.entity.position.distanceTo(start))} blocks from where it began (cap ${ATTACK_LEASH}); ${swings} swings landed`)
      if (bot.entities?.[target.id] !== target) {
        // An enderman teleports, a mob despawns: re-acquire the nearest of the
        // same type near where it was last seen rather than abandoning the plan.
        const again = nearestOfType(bot, goal.type, lastSeen, REACQUIRE_RADIUS)
        if (!again) throw new Error(`Lost the ${goal.type}: last seen ${Math.round(lastSeen.distanceTo(bot.entity.position))} blocks away, none within ${REACQUIRE_RADIUS} blocks of there; ${swings} swings landed, no kill confirmed`)
        target = again; reacquired++; following = false
        progress(`Re-acquired a ${goal.type} ${Math.round(target.position.distanceTo(bot.entity.position))} blocks away`)
      }
      lastSeen = target.position.clone()
      if (strikeable()) {
        if (following) { bot.pathfinder.setGoal(null); following = false }
        await bot.lookAt?.(point(target.position).offset(0, Math.min(1.2, (target.height || 1.8) / 2), 0), true)
        check()
        if (!dead && Date.now() >= nextSwing && strikeable()) { bot.attack(target); swings++; nextSwing = Date.now() + cooldown }
      } else if (!following || !bot.pathfinder.goal) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); following = true
      }
      await delay(50)
    }
  } finally {
    ;(bot.removeListener || bot.off)?.call(bot, 'entityDead', killed)
    bot.pathfinder.setGoal(null); bot.clearControlStates?.()
    if (movements) bot.pathfinder.setMovements(movements)
  }
  if (!swings) throw new Error(`The ${goal.type} died before any swing landed; no kill can be attributed`)
  // Drops land a few ticks after death.
  for (let i = 0; i < 20; i++) { check(); await delay(100); if (Object.keys(inventoryDelta(before, inventoryCounts(bot))).length) break }
  return { receipt: 'target_death_observed', type: goal.type, weapon: weapon ? weapon.name : 'fists', swings, reacquired, drops: inventoryDelta(before, inventoryCounts(bot)), attribution: 'Server death observed after our attacks; exclusive kill attribution requires server statistics' }
}
