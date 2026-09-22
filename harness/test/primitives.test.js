import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import minecraftData from 'minecraft-data'
import { validatePlan, schema } from '../src/companion/planner.js'
import { validateGotoGoal, validateDigGoal, gotoPosition, digToward } from '../src/primitives.js'
import { validateTaskGoal } from '../src/task-store.js'

const registry = minecraftData('1.21.4')
const air = (p) => ({ name: 'air', boundingBox: 'empty', position: p?.clone?.() || p, diggable: false, harvestTools: {} })
const stone = (p) => ({ name: 'stone', boundingBox: 'block', position: p?.clone?.() || p, diggable: true, harvestTools: { [registry.itemsByName.wooden_pickaxe.id]: true } })
const lava = (p) => ({ name: 'lava', boundingBox: 'empty', position: p?.clone?.() || p, diggable: false })

const gotoStep = (over = {}) => ({
  action: 'goto', name: '', count: 0, item: '', design: [],
  target: { x: 10, y: 64, z: 0, dig: true }, ...over,
})
const digStep = (over = {}) => ({
  action: 'dig', name: '', count: 1, item: '', design: [],
  target: { x: 1, y: 64, z: 0 }, ...over,
})

test('validatePlan accepts well-formed goto and dig steps', () => {
  const goto = validatePlan({ reply: 'Moving closer.', steps: [gotoStep()] })
  assert.deepEqual(goto.steps[0], { action: 'goto', name: '', count: 0, target: { x: 10, y: 64, z: 0, dig: true } })
  const dig = validatePlan({ reply: 'Opening a tunnel.', steps: [digStep({ count: 3 })] })
  assert.deepEqual(dig.steps[0], { action: 'dig', name: '', count: 3, target: { x: 1, y: 64, z: 0 } })
  assert.deepEqual(validateTaskGoal('goto', { x: 10, y: 64, z: 0, dig: false }), { x: 10, y: 64, z: 0, dig: false })
  assert.deepEqual(validateTaskGoal('dig', { x: 1, y: 64, z: 0, count: 2 }), { x: 1, y: 64, z: 0, count: 2 })
})

test('validatePlan rejects a goto without boolean dig, dig count bounds, and targets on unrelated actions', () => {
  assert.throws(() => validatePlan({ reply: 'x', steps: [gotoStep({ target: { x: 1, y: 2, z: 3 } })] }), /boolean dig|dig/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [digStep({ count: 0 })] }), /1–32|1-32/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [digStep({ count: 33 })] }), /1–32|1-32/)
  assert.throws(
    () => validatePlan({ reply: 'x', steps: [{ action: 'gather', name: '', count: 4, item: 'oak_log', design: [], target: { x: 1, y: 2, z: 3 } }] }),
    /Only travel.*use.*goto.*dig|Only travel, use, goto and dig/,
  )
})

test('schema-derived labels exist for goto and dig', () => {
  const src = readFileSync(new URL('../src/companion/controller.js', import.meta.url), 'utf8')
  const line = src.split('\n').find(l => l.includes('const labels={'))
  for (const action of schema.properties.steps.items.properties.action.enum.filter(a => a !== 'gather_and_return')) {
    assert.ok(line.includes(action + ':'), action + ' label')
  }
  assert.ok(schema.properties.steps.items.properties.action.enum.includes('goto'))
  assert.ok(schema.properties.steps.items.properties.action.enum.includes('dig'))
})

test('goto and dig pass intent and skill-control admission', async () => {
  const { guardIntent } = await import('../src/companion/intent.js')
  const { SKILL_ACTIONS } = await import('../src/companion/skill-control.js')
  for (const step of [gotoStep(), digStep({ count: 2 })]) {
    const plan = validatePlan({ reply: 'ok', steps: [step] })
    assert.deepEqual(guardIntent(plan, 'dig toward that air pocket'), plan)
    assert.ok(SKILL_ACTIONS.has(step.action), step.action + ' must be selectable under Jev skill control')
  }
})

function fakeBot(over = {}) {
  const pos = over.position || new Vec3(0.5, 64, 0.5)
  const world = new Map()
  for (const [x, y, z, block] of over.fills || []) {
    const p = new Vec3(x, y, z)
    world.set(`${x},${y},${z}`, typeof block === 'function' ? block(p) : { ...block, position: p })
  }
  const listeners = {}
  const bot = {
    entity: { position: pos.clone(), onGround: true },
    registry,
    inventory: { items: () => over.items || [{ name: 'wooden_pickaxe', count: 1, type: registry.itemsByName.wooden_pickaxe.id }] },
    pathfinder: over.pathfinder || {
      movements: null,
      setMovements(m) { this.movements = m },
      setGoal() {},
      async goto(goal) {
        const x = goal.x ?? Math.floor(bot.entity.position.x)
        const y = goal.y ?? Math.floor(bot.entity.position.y)
        const z = goal.z ?? Math.floor(bot.entity.position.z)
        bot.entity.position = new Vec3(x + 0.5, y, z + 0.5)
      },
    },
    tool: { equipForBlock: async () => {} },
    canDigBlock: over.canDigBlock || ((b) => !!b?.diggable),
    dig: async (block) => {
      bot._dug = (bot._dug || 0) + 1
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      world.set(key, air(block.position))
      listeners.diggingCompleted?.forEach(fn => fn(air(block.position)))
    },
    on(ev, fn) { (listeners[ev] ||= []).push(fn) },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn) },
    clearControlStates() {},
  }
  bot.blockAt = over.blockAt || ((p) => {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    if (world.has(key)) return world.get(key)
    return over.defaultBlock ? over.defaultBlock(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) : air(p)
  })
  bot.world = { getBlock: p => bot.blockAt(p) }
  return bot
}
const deps = () => ({ check() {}, stage() {}, progress() {}, movements: null })

test('dig refuses a liquid target, a saved-project cell, and an unloaded target', async () => {
  const liquid = fakeBot({ fills: [[1, 64, 0, lava]] })
  assert.equal(liquid.blockAt(new Vec3(1, 64, 0))?.name, 'lava')
  await assert.rejects(() => digToward(liquid, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()), /lava|liquid/i)
  assert.equal(liquid._dug || 0, 0)

  const project = fakeBot({ fills: [[5, 64, 0, stone]] })
  await assert.rejects(
    () => digToward(project, { kind: 'dig', goal: validateDigGoal({ x: 5, y: 64, z: 0, count: 1, protectedSites: [{ minX: 5, maxX: 5, minZ: 0, maxZ: 0 }] }) }, deps()),
    /saved project|project footprint/i,
  )

  const unloaded = fakeBot({ blockAt: () => null })
  await assert.rejects(() => digToward(unloaded, { kind: 'dig', goal: validateDigGoal({ x: 40, y: 64, z: 0, count: 1 }) }, deps()), /not loaded|Travel closer|far/i)
})

test('dig with zero broken throws rather than returning a partial receipt', async () => {
  const bot = fakeBot({
    canDigBlock: () => false,
    fills: [[1, 64, 0, stone]],
  })
  bot.entity.position = new Vec3(1.5, 64, 0.5)
  await assert.rejects(() => digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()), /./)
  assert.equal(bot._dug || 0, 0)
})

test('dig breaks a 3-step tunnel (feet and head each step) and reports broken:3', async () => {
  const fills = []
  for (let x = 1; x <= 3; x++) {
    fills.push([x, 64, 0, stone], [x, 65, 0, stone])
    fills.push([x, 63, 0, stone])
  }
  const bot = fakeBot({ fills })
  const result = await digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 3, y: 64, z: 0, count: 3 }) }, deps())
  assert.equal(result.receipt, 'dug')
  assert.equal(result.broken, 3)
  assert.equal(result.requested, 3)
  assert.equal(result.stoppedAt, null)
  assert.ok(bot._dug >= 6, `feet and head broken each step, dug=${bot._dug}`)
})

test('dig stops before a lava-adjacent cell and names lava in the reason', async () => {
  const fills = [
    [1, 64, 0, stone], [1, 65, 0, stone], [1, 63, 0, stone],
    [2, 64, 0, stone], [2, 65, 0, stone], [2, 63, 0, stone],
    [3, 64, 0, lava], [3, 65, 0, air], [3, 63, 0, stone],
  ]
  const bot = fakeBot({ fills })
  const result = await digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 3, y: 64, z: 0, count: 3 }) }, deps())
  assert.equal(result.receipt, 'dug')
  assert.ok(result.broken >= 1 && result.broken < 3, `broken=${result.broken} reason=${result.reason}`)
  assert.match(result.reason, /lava/i)
  assert.ok(result.stoppedAt)
})

test('goto dig:true enables canDig and scaffold; dig:false matches travel soft-break profile', async () => {
  const profiles = []
  const bot = fakeBot({
    items: [
      { name: 'wooden_pickaxe', count: 1, type: registry.itemsByName.wooden_pickaxe.id },
      { name: 'cobblestone', count: 8, type: registry.itemsByName.cobblestone.id },
    ],
    pathfinder: {
      movements: null,
      setMovements(m) { profiles.push(m); this.movements = m },
      setGoal() {},
      async goto(goal) {
        bot.entity.position = new Vec3((goal.x ?? 0) + 0.5, goal.y ?? 64, (goal.z ?? 0) + 0.5)
      },
    },
  })
  await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 4, y: 64, z: 0, dig: true }) }, deps())
  const digging = profiles.at(-1)
  assert.equal(digging.canDig, true)
  assert.ok(digging.scafoldingBlocks?.length > 0, 'carried full cubes become scaffold')
  assert.equal(digging.allow1by1towers, true)

  profiles.length = 0
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 4, y: 64, z: 0, dig: false }) }, deps())
  const soft = profiles.at(-1)
  assert.equal(soft.canDig, true)
  assert.deepEqual(soft.scafoldingBlocks || [], [])
  assert.equal(soft.allow1by1towers, false)
})

test('goto refuses destinations beyond 64 blocks and names the distance', async () => {
  const bot = fakeBot()
  await assert.rejects(
    () => gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 100, y: 64, z: 0, dig: false }) }, deps()),
    /64|100|intermediate goto/i,
  )
})

test('goto arrival receipt reports arrived shape with dug/placed counts', async () => {
  const bot = fakeBot()
  const result = await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 3, y: 64, z: 0, dig: false }) }, deps())
  assert.equal(result.receipt, 'arrived')
  assert.ok(result.from && Number.isInteger(result.from.x))
  assert.ok(result.to && result.to.x === 3)
  assert.equal(typeof result.distance, 'number')
  assert.equal(typeof result.dug, 'number')
  assert.equal(typeof result.placed, 'number')
  assert.ok(result.countsFrom === 'events' || result.countsFrom === 'inventory_delta')
})
