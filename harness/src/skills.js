import {eatFood} from './survival.js'
import {surfaceForAir} from './water-safety.js'
import {burrowIn,unburrow} from './burrow.js'
import {wallIn,unwall} from './hut.js'
import {defendAgainstMob} from './combat.js'
import {EXPEDITION_ACTIONS} from './prospecting.js'
import {PREPARE_ACTIONS} from './supplies.js'
import {STATION_ACTIONS} from './stations.js'
import {executeWorldSkill} from './world-skills.js'
import {deliverItem} from './delivery.js'
import {craftWithWindowState} from './crafting.js'
import { resourceNames, resourceLabel, gatherCandidates } from './resources.js'
import pathfinding from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { setTimeout as delay } from 'node:timers/promises'
const { goals } = pathfinding
export const countItem = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

// Every await boundary rechecks task identity. Goals describe desired inventory,
// so reconnects re-observe rather than blindly repeat a resource-consuming step.
export async function executeSkill(bot, task, context) {
  if(task.kind==='surface')return surfaceForAir(bot,task,context)
  if(task.kind==='burrow')return burrowIn(bot,task,context)
  if(task.kind==='unburrow')return unburrow(bot,task,context)
  if(task.kind==='hut')return wallIn(bot,task,context)
  if(task.kind==='unhut')return unwall(bot,task,context)
  if(task.kind==='defend')return defendAgainstMob(bot,task,context)
  if(task.kind==='eat')return eatFood(bot,task,context)
  if(task.kind==='give')return deliverItem(bot,task,context)
  const { check, progress, stage } = context
  async function observeStable(predicate, message) {
    const deadline = Date.now() + 3000
    let stable = 0
    while (Date.now() < deadline) {
      check()
      const value = predicate()
      stable = value ? stable + 1 : 0
      if (stable >= 3) return value
      await delay(50)
    }
    throw new Error(message)
  }
  async function gather(count, item = 'oak_log') {
    const names = resourceNames(item)
    const total = () => names.reduce((n, name) => n + countItem(bot, name), 0)
    const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
    if (!ids.length) throw new Error(`${resourceLabel(item)} unavailable in this version`)
    let stalled = 0, legs = 0
    const skipped = new Set(), skippedColumns = new Set()
    const scan = (maxDistance, limit) => gatherCandidates(bot,bot.findBlocks({ matching: ids, maxDistance, count: limit }),{skipped,skippedColumns})
    async function walk(goal, ms = 15000) {
      check()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; bot.pathfinder.setGoal(null) }, ms)
      try { await bot.pathfinder.goto(goal) } catch (error) {
        if (timedOut) throw Object.assign(new Error('Movement timed out'), {name:'Timeout'})
        throw error
      } finally { clearTimeout(timer) }
      check()
    }
    // A fresh spawn can have no trunk within the 48-block collection radius.
    // Walk toward one sighted in the loaded area, otherwise probe cardinal legs
    // from the start, re-scanning after each leg; at most eight legs per job.
    async function explore() {
      const origin = bot.entity.position.clone()
      while (legs < 8) {
        check(); legs++
        const far = scan(128, 64)[0]; let target
        if (far) {
          const p = bot.entity.position, dx = far.position.x - p.x, dz = far.position.z - p.z, dist = Math.hypot(dx, dz)
          if (dist <= 40) return
          const step = Math.min(32, dist) / dist; target = { x: p.x + dx * step, z: p.z + dz * step }
          progress(`Walking toward ${resourceLabel(item)} sighted ${Math.round(dist)} blocks away`)
        } else {
          const [dx, dz] = [[32, 0], [0, 32], [-32, 0], [0, -32]][(legs - 1) % 4], ring = Math.ceil(legs / 4)
          target = { x: origin.x + dx * ring, z: origin.z + dz * ring }
          progress(`Exploring for ${resourceLabel(item)}: leg ${legs} of 8`)
        }
        stage('walking'); bot.pathfinder.setMovements(context.movements)
        try { await walk(new goals.GoalXZ(Math.round(target.x), Math.round(target.z)), 20000) }
        catch (error) { check(); if (!['NoPath', 'Timeout'].includes(error.name)) throw error }
        bot.pathfinder.setGoal(null); check()
        if (scan(48, 512).length) return
      }
      throw new Error(`no ${resourceLabel(item)} within 48 blocks after exploring 8 legs from the start; move me near trees`)
    }
    while (total() < count) {
      check()
      let block
      try { block = await observeStable(() => scan(48, 512)[0], `no ${resourceLabel(item)} within 48 blocks`) }
      catch (error) { check(); if (!error.message.startsWith('no ') || legs >= 8) throw error; await explore(); continue }
      const before = total()
      progress(`Collecting ${resourceLabel(item)}: ${before}/${count}`)
      stage('gathering')
      let pathError
      try {
        bot.pathfinder.setMovements(context.gatheringMovements)
        stage('walking')
        if (!bot.canDigBlock(block)) await walk(new goals.GoalLookAtBlock(block.position, bot.world))
        check()
        const observed = bot.blockAt(block.position)
        if (names.includes(observed?.name)) {
          stage('gathering')
          await bot.tool.equipForBlock(observed, {requireHarvest:true, getFromChest:false})
          check()
          await bot.dig(observed)
          check()
        }
        // Pick up at the block's former position. Do not follow a dropped-item
        // entity at zero distance: pickup removes that entity while walking.
        await delay(500); check()
        if (total() <= before) {
          stage('walking')
          await walk(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1))
          await delay(500); check()
        }
      } catch (error) {
        check()
        if (!['NoPath', 'Timeout'].includes(error.name)) throw error
        pathError = error
      }
      check()
      bot.pathfinder.setGoal(null)
      bot.pathfinder.setMovements(context.movements)
      await delay(200); check()
      if (pathError && total() <= before) {
        skipped.add(block.position.toString()); skippedColumns.add(`${block.position.x},${block.position.z}`)
        progress(`Cannot reach that log; trying another tree (${total()}/${count})`)
      }
      if (total() <= before) {
        skipped.add(block.position.toString()); skippedColumns.add(`${block.position.x},${block.position.z}`)
        if (++stalled >= 12) throw new Error(`no reachable ${resourceLabel(item)} after checking 12 targets; carrying ${total()}/${count}`)
      } else stalled = 0
    }
  }
  async function craftOne(name, table = null) {
    check()
    const id = bot.registry.itemsByName[name]?.id
    if (id === undefined) throw new Error(`${name} unavailable in this version`)
    // Server inventory corrections can arrive after craft() resolves. Wait for
    // stable recipe availability; never retry a resource-consuming craft blindly.
    const recipe = await observeStable(() => bot.recipesFor(id, null, 1, table)[0], `missing ingredients for ${name}`)
    const before = countItem(bot, name)
    progress(`Crafting ${name.replaceAll('_', ' ')}`)
    stage('crafting')
    try { await craftWithWindowState(bot, recipe, 1, table,check) } finally { stage('observing') }
    check()
    await observeStable(() => countItem(bot, name) >= before + recipe.result.count, `craft did not produce ${name}`)
  }
  async function planks(count) {
    while (countItem(bot, 'oak_planks') < count) {
      check()
      if (countItem(bot, 'oak_log') < 1) await gather(1)
      check()
      await craftOne('oak_planks')
    }
  }
  if (['harvest','acquire','build','construct',...PREPARE_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(task.kind))return executeWorldSkill(bot,task,context,gather)
  if (task.kind === 'gather') {
    await gather(task.goal.count, task.goal.item)
    return { item: task.goal.item, count: resourceNames(task.goal.item).reduce((n, name) => n + countItem(bot, name), 0) }
  }
  if (task.kind !== 'craft') throw new Error('unknown skill')
  if (countItem(bot, 'wooden_pickaxe') >= 1) return { item: 'wooden_pickaxe', count: countItem(bot, 'wooden_pickaxe') }
  let table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 })
  if (!table) {
    if (countItem(bot, 'crafting_table') < 1) { await planks(4); await craftOne('crafting_table') }
    check()
    const p = bot.entity.position.floored()
    let floor
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0]]) {
      const base = bot.blockAt(p.offset(dx, -1, dz))
      const above = base && bot.blockAt(base.position.offset(0, 1, 0))
      if (base?.boundingBox === 'block' && above?.name === 'air') { floor = base; break }
    }
    if (!floor) throw new Error('no clear floor beside bot for crafting table')
    progress('Placing crafting table')
    await bot.equip(bot.inventory.items().find(i => i.name === 'crafting_table'), 'hand')
    check(); stage('placing')
    try { await bot.placeBlock(floor, new Vec3(0, 1, 0)) } finally { stage('observing') }
    check()
    table = bot.blockAt(floor.position.offset(0, 1, 0))
    if (table?.name !== 'crafting_table') throw new Error('crafting table placement not observed')
  }
  if (countItem(bot, 'stick') < 2) { await planks(2); await craftOne('stick') }
  await planks(3)
  check(); stage('walking')
  bot.pathfinder.setMovements(context.movements)
  await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
  check()
  table = bot.blockAt(table.position)
  if (table?.name !== 'crafting_table') throw new Error('crafting table is gone')
  await craftOne('wooden_pickaxe', table)
  return { item: 'wooden_pickaxe', count: countItem(bot, 'wooden_pickaxe') }
}
