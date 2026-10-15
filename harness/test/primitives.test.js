import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import minecraftData from 'minecraft-data'
import { validatePlan, schema } from '../src/companion/planner.js'
import { validateGotoGoal, validateDigGoal, gotoPosition, digToward, walkNear } from '../src/primitives.js'
import { validateTaskGoal } from '../src/task-store.js'
import { Runner } from '../src/runner.js'

// Live, 2026-09-22: eleven consecutive dig steps and four goto steps each ran
// their full deadline with no skill_progress at all. runner.applyGoal keeps a
// hardcoded list of task kinds that run as skills; anything else falls through
// to the legacy bare-navigation branch, which walked at a solid block forever.
test('goto and dig dispatch as skills, never as bare navigation', () => {
  for (const kind of ['goto', 'dig']) {
    const calls = []
    const runner = {
      ready: true, connectionId: 'c1',
      task: { kind, status: 'running', goal: { x: 1, y: 64, z: 1, dig: true, count: 1 }, deadline: Date.now() + 10000 },
      bot: { pathfinder: { setGoal: g => calls.push(['navigate', g]) } },
      log: (type, data) => calls.push([type]),
      finish: (status, reason) => calls.push(['finish', status, reason]),
      runSkill: () => calls.push(['runSkill']),
    }
    Runner.prototype.applyGoal.call(runner)
    assert.deepEqual(calls, [['runSkill']], `${kind} must run as a skill, got ${JSON.stringify(calls)}`)
  }
})

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

// mineflayer 4.38's own rule: breakable, and the block centre within 5.1 of the eyes.
const eyeReach = bot => b => !!b?.diggable && b.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1

test('dig walks to an ore just past eye reach instead of blaming the tools', async () => {
  // Trial 7, 23 September: "Cannot dig iron_ore at -651,57,-295 with carried
  // tools from here", holding a stone pickaxe. canDigBlock tests only
  // breakability and eye reach; a cell below the feet is 4.4 from them and 5.2
  // from the eyes, so it was refused before the walk that would have fixed it.
  const ore = p => ({ name: 'iron_ore', boundingBox: 'block', diggable: true, position: p })
  const bot = fakeBot({
    items: [{ name: 'stone_pickaxe', count: 1, type: registry.itemsByName.stone_pickaxe.id }],
    fills: [[4, 62, 1, ore]],
    defaultBlock: p => (p.y < 64 ? stone(p) : { name: 'air', boundingBox: 'empty', position: p }),
  })
  bot.canDigBlock = eyeReach(bot)
  assert.equal(bot.canDigBlock(bot.blockAt(new Vec3(4, 62, 1))), false, 'fixture: out of eye reach from the start')
  const start = bot.entity.position.clone()
  const r = await digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 4, y: 62, z: 1, count: 1 }) }, deps())
  assert.equal(r.broken, 1)
  assert.ok(bot.entity.position.distanceTo(start) > 0, 'it walked within reach first')
})

test('dig refuses an unbreakable block by saying so', async () => {
  const bot = fakeBot({ fills: [[1, 64, 0, { name: 'bedrock', boundingBox: 'block', diggable: false }], [1, 63, 0, stone]] })
  bot.canDigBlock = eyeReach(bot)
  await assert.rejects(
    () => digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()),
    /bedrock at 1,64,0 cannot be broken/,
  )
})

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

// Trial 3 live: told to dig toward a cell above it, the agent cut a chimney it
// could not climb, then spent rounds on goto legs that timed out three blocks
// short, straight up. Stepping into a cleared column must use the profile that
// carries scaffold and may tower one block, or an upward dig strands the digger.
test('dig steps into each cleared column with the scaffold-capable profile and follows an upward line', async () => {
  const profiles = []
  const fills = []
  for (let y = 65; y <= 69; y++) fills.push([0, y, 0, stone])
  fills.push([0, 63, 0, stone])
  const bot = fakeBot({
    fills,
    items: [
      { name: 'wooden_pickaxe', count: 1, type: registry.itemsByName.wooden_pickaxe.id },
      { name: 'dirt', count: 20, type: registry.itemsByName.dirt.id },
    ],
    pathfinder: {
      movements: null,
      setMovements(m) { profiles.push(m); this.movements = m },
      setGoal() {},
      async goto(goal) { bot.entity.position = new Vec3((goal.x ?? 0) + 0.5, goal.y ?? 64, (goal.z ?? 0) + 0.5) },
    },
  })
  const result = await digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 0, y: 68, z: 0, count: 4 }) }, deps())
  assert.equal(result.receipt, 'dug')
  assert.equal(result.broken, 4, `broken=${result.broken} reason=${result.reason}`)
  assert.ok(profiles.length >= 3, 'stepped into columns')
  for (const p of profiles) {
    assert.equal(p.canDig, true, 'stepping into a column uses the dig profile')
    assert.ok(p.scafoldingBlocks?.length > 0, 'carried dirt is scaffold for towering into the column')
  }
  assert.equal(Math.floor(bot.entity.position.y), 68, 'the digger rose with its own chimney')
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
  // Live, trial 4: goto dig:true could not rise two blocks with 55 dirt in the
  // bag. The pathfinder counts scaffold by item.type === id, an ITEM id; block
  // ids are a different table (dirt is block 9, item 28), so it counted zero.
  assert.ok(digging.scafoldingBlocks.includes(registry.itemsByName.cobblestone.id), 'scaffold ids are item ids')
  assert.ok(!digging.scafoldingBlocks.includes(registry.blocksByName.cobblestone.id) || registry.blocksByName.cobblestone.id === registry.itemsByName.cobblestone.id, 'no block ids in the scaffold list')
  assert.ok(digging.countScaffoldingItems() >= 8, 'the pathfinder can see the eight cobblestone as scaffold')
  // Live, trial 3: `goto dig:true` reported "no route" with stone two blocks
  // ahead. mineflayer's canDigBlock also tests reach, so every block beyond
  // arm's length read as unbreakable and no tunnel could ever be planned. The
  // profile must judge breakability by the block, not by where the bot stands.
  bot.canDigBlock = () => false
  const farStone = stone(new Vec3(12, 64, 0))
  const bedrock = { name: 'bedrock', boundingBox: 'block', position: new Vec3(12, 63, 0), diggable: false }
  const cost = block => digging.exclusionAreasBreak.reduce((n, f) => n + f(block), 0)
  assert.equal(cost(farStone), 0, 'diggable stone out of reach is still a candidate for the pathfinder')
  assert.equal(cost(bedrock), 100, 'bedrock is never a candidate')

  profiles.length = 0
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 4, y: 64, z: 0, dig: false }) }, deps())
  const soft = profiles.at(-1)
  assert.equal(soft.canDig, true)
  assert.deepEqual(soft.scafoldingBlocks || [], [])
  assert.equal(soft.allow1by1towers, false)
})

async function gotoProfile(goal) {
  const profiles = []
  const bot = fakeBot({
    // Ground under the scaffold: a placement over a bottomless drop is refused on its own.
    defaultBlock: p => (p.y <= 63 ? stone(p) : air(p)),
    items: [
      { name: 'wooden_pickaxe', count: 1, type: registry.itemsByName.wooden_pickaxe.id },
      { name: 'cobblestone', count: 8, type: registry.itemsByName.cobblestone.id },
    ],
    pathfinder: {
      movements: null,
      setMovements(m) { profiles.push(m); this.movements = m },
      setGoal() {},
      async goto(g) { bot.entity.position = new Vec3((g.x ?? 0) + 0.5, g.y ?? 64, (g.z ?? 0) + 0.5) },
    },
  })
  await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal(goal) }, deps())
  return profiles.at(-1)
}

test('neither goto profile places scaffold inside a saved project footprint', async () => {
  const protectedSites = [{ minX: 10, maxX: 14, minZ: -2, maxZ: 2 }]
  for (const dig of [true, false]) {
    const profile = await gotoProfile({ x: 4, y: 64, z: 0, dig, protectedSites })
    assert.ok(profile.exclusionPlace(air(new Vec3(12, 65, 0))) >= 100, `dig:${dig} must not place inside the footprint`)
    assert.equal(profile.exclusionPlace(air(new Vec3(20, 65, 0))), 0, `dig:${dig} may place outside the footprint`)
  }
})

test('goto dig:true will not tunnel through workstations, storage, lights or doors', async () => {
  const digging = await gotoProfile({ x: 4, y: 64, z: 0, dig: true })
  const block = name => ({ name, boundingBox: 'block', position: new Vec3(8, 64, 0), diggable: true })
  for (const name of ['furnace', 'crafting_table', 'barrel', 'torch', 'red_bed', 'oak_door', 'spruce_trapdoor', 'oak_fence_gate', 'oak_wall_sign', 'white_shulker_box', 'anvil'])
    assert.ok(digging.exclusionBreak(block(name)) >= 100, `${name} must not be a tunnel candidate`)
  for (const name of ['stone', 'deepslate', 'dirt', 'iron_ore', 'oak_leaves'])
    assert.equal(digging.exclusionBreak(block(name)), 0, `${name} stays breakable`)
  // A world shared with players (4 October): never tunnel through what someone
  // built, a portal included. Obsidian is mined on purpose by make_obsidian.
  for (const name of ['oak_planks', 'cobblestone', 'glass', 'white_wool', 'bricks', 'oak_log', 'obsidian', 'stone_bricks'])
    assert.ok(digging.exclusionBreak(block(name)) >= 100, `${name} is a building block, not a tunnel`)
})

test('goto dig:true prices digging like travel, so a short detour beats a tunnel', async () => {
  const { TRAVERSAL_DIG_COST } = await import('../src/navigation.js')
  const digging = await gotoProfile({ x: 4, y: 64, z: 0, dig: true })
  assert.equal(digging.digCost, TRAVERSAL_DIG_COST)
})

test('dig refuses a workstation by name and says what to do instead', async () => {
  const bot = fakeBot({ fills: [[1, 64, 0, { name: 'crafting_table', boundingBox: 'block', diggable: true }], [1, 63, 0, stone]] })
  await assert.rejects(
    () => digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()),
    { message: 'crafting_table at 1,64,0 is a workstation or fixture; dig does not break those. Use revise for a saved build, or choose another cell.' },
  )
  assert.equal(bot._dug || 0, 0)
})

test('goto refuses a destination beside lava before taking a step', async () => {
  // Trial 21: the planner sent goto to a cell on a lava pool's edge "to look for
  // a bigger lava exposure"; the bot arrived burning and died ten seconds later.
  const bot = fakeBot({ fills: [[5, 64, 0, lava]] })
  await assert.rejects(
    () => gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 4, y: 64, z: 0, dig: true }) }, deps()),
    /4,64,0 is beside lava at 5,64,0/,
  )
  assert.equal(bot.entity.position.x, 0.5, 'refused before moving')
  const head = fakeBot({ fills: [[5, 65, 1, lava]] })
  await assert.rejects(() => gotoPosition(head, { kind: 'goto', goal: validateGotoGoal({ x: 4, y: 64, z: 0, dig: false }) }, deps()), /beside lava at 5,65,1/, 'head height and diagonals count')
  const ok = await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 3, y: 64, z: 0, dig: false }) }, deps())
  assert.equal(ok.receipt, 'arrived', 'two cells off is allowed')
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

// Live, 2026-09-23: goto, dig, collect and place_at all logged "Goto leg
// exceeded its 25 second budget". An expired leg threw, so every walk was one
// leg long and the 30s-8min walk budgets were never reached.
function steppingPathfinder(bot, { step, resolveEachLeg = false, legs }) {
  return {
    movements: null,
    setMovements(m) { this.movements = m },
    setGoal() {},
    goto(goal) {
      legs.push(goal)
      const p = bot.entity.position, dx = goal.x + 0.5 - p.x
      bot.entity.position = new Vec3(p.x + Math.sign(dx) * Math.min(step, Math.abs(dx)), p.y, p.z)
      const near = bot.entity.position.distanceTo(new Vec3(goal.x, goal.y, goal.z)) <= 2
      return near || resolveEachLeg ? Promise.resolve() : new Promise(() => {})
    },
  }
}

test('a stuck leg says what the pathfinder was doing', async () => {
  // Trial 8: stuck legs were a third of movement tasks, and each logged nothing
  // for 25 seconds before "without closing ground". The pathfinder reports its
  // plans and every path reset as events; the refusal should carry them.
  const bot = fakeBot()
  const handlers = {}
  bot.on = (e, f) => { (handlers[e] ||= []).push(f) }
  bot.off = (e, f) => { handlers[e] = (handlers[e] || []).filter(g => g !== f) }
  const emit = (e, ...a) => (handlers[e] || []).forEach(f => f(...a))
  const node = (x, y, z, places = 0, digs = 0) => ({ x, y, z, toPlace: Array(places).fill({}), toBreak: Array(digs).fill({}) })
  bot.pathfinder = {
    setMovements() {}, setGoal() {},
    goto() {
      emit('path_update', { status: 'success', path: [node(0, 65, 0, 1), node(0, 66, 0, 1), node(1, 66, 0)] })
      emit('path_reset', 'place_error'); emit('path_reset', 'place_error'); emit('path_reset', 'stuck')
      return new Promise(() => {})
    },
  }
  const error = await walkNear(bot, { x: 5, y: 66, z: 0 }, { dig: true, ...deps(), legTimeoutMs: 50 }).then(() => null, e => e)
  assert.ok(error, 'the leg refused')
  assert.match(error.message, /without closing ground/)
  assert.match(error.message, /last plan 3 steps, 2 places, 0 digs/)
  assert.match(error.message, /place_error x2/)
  assert.match(error.message, /stuck x1/)
  assert.deepEqual(handlers.path_update, [], 'listeners are removed after the leg')
})

test('a stuck leg says whether physics was running', async () => {
  // Trial 10: stuck legs began with onGround false on solid ground and a
  // position frozen for minutes. mineflayer skips physics before the server's
  // first position, after respawn or mount, and over an unloaded chunk; the
  // pathfinder then gives up every 3.5 seconds. Whether ticks ran is decisive.
  const run = async ticks => {
    const bot = fakeBot()
    const handlers = {}
    bot.on = (e, f) => { (handlers[e] ||= []).push(f) }
    bot.off = (e, f) => { handlers[e] = (handlers[e] || []).filter(g => g !== f) }
    bot.entity.onGround = false
    bot.entity.velocity = new Vec3(0, -0.0784, 0)
    bot.pathfinder = { setMovements() {}, setGoal() {}, goto() {
      for (let i = 0; i < ticks; i++) (handlers.physicsTick || []).forEach(f => f())
      return new Promise(() => {})
    } }
    return walkNear(bot, { x: 5, y: 64, z: 0 }, { dig: false, ...deps(), legTimeoutMs: 50 }).then(() => null, e => e.message)
  }
  assert.match(await run(0), /physics ticks 0; server corrections 0; onGround false, velocity 0,-0.08,0/)
  assert.match(await run(3), /physics ticks 3;/)
})

test('a stuck leg counts server corrections and names what the client thinks is underfoot', async () => {
  // Trial 10, live: y held at exactly 64.0 with onGround false for 25 seconds
  // while z flickered by 0.01, during a quarry that digs underfoot. A client
  // that believes its floor is gone falls; a server that disagrees teleports it
  // back. mineflayer emits forcedMove for each correction.
  const bot = fakeBot({ blockAt: p => (Math.floor(p.y) === 63 ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }) })
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  const handlers = {}
  bot.on = (e, f) => { (handlers[e] ||= []).push(f) }
  bot.off = (e, f) => { handlers[e] = (handlers[e] || []).filter(g => g !== f) }
  bot.pathfinder = { setMovements() {}, setGoal() {}, goto() {
    for (let i = 0; i < 4; i++) (handlers.forcedMove || []).forEach(f => f())
    return new Promise(() => {})
  } }
  const message = await walkNear(bot, { x: 5, y: 64, z: 0 }, { dig: false, ...deps(), legTimeoutMs: 50 }).then(() => null, e => e.message)
  assert.match(message, /server corrections 4/)
  assert.match(message, /underfoot air/)
})

test('a stuck leg reports how far each correction moved the bot and the solid cells the client sees around it', async () => {
  // Trial 11: ~480 server corrections in 25 seconds, velocity zeroed each time.
  // A snap-back of a few tenths each tick is the server refusing a move into
  // what it holds solid; near zero is the server re-sending the same place.
  // The client's solid cells beside the body, with coordinates, can then be
  // checked against the server block by block.
  const leaves = { name: 'spruce_leaves', boundingBox: 'block' }
  const bot = fakeBot({ blockAt: p => (Math.floor(p.y) < 64 ? { name: 'grass_block', boundingBox: 'block' } : Math.floor(p.x) === 1 && Math.floor(p.y) === 65 ? leaves : { name: 'air', boundingBox: 'empty' }) })
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  const handlers = {}
  bot.on = (e, f) => { (handlers[e] ||= []).push(f) }
  bot.off = (e, f) => { handlers[e] = (handlers[e] || []).filter(g => g !== f) }
  const emit = e => (handlers[e] || []).forEach(f => f())
  bot.pathfinder = { setMovements() {}, setGoal() {}, goto() {
    for (let i = 0; i < 3; i++) {
      bot.entity.position = new Vec3(0.8, 64, 0.5); emit('physicsTick')
      bot.entity.position = new Vec3(0.5, 64, 0.5); emit('forcedMove')
    }
    return new Promise(() => {})
  } }
  const message = await walkNear(bot, { x: 5, y: 64, z: 0 }, { dig: false, ...deps(), legTimeoutMs: 50 }).then(() => null, e => e.message)
  assert.match(message, /corrections moved it 0\.3 on average, last to 0\.5,64,0\.5/)
  assert.match(message, /client solid cells: 0,63,0 grass_block; .*1,65,0 spruce_leaves/)
})

test('a stuck leg reports the raw position packets behind the corrections', async () => {
  // Trial 12: the client and server agreed on every cell, yet the server sent
  // the bot back ~20 times a second by 0.02 blocks. Rising teleport ids are the
  // server starting a new teleport each tick; one repeated id is it waiting on
  // a confirmation that never lands; relative flags point at the bridge.
  const bot = fakeBot()
  const handlers = {}, client = new (await import('node:events')).EventEmitter()
  bot._client = client
  bot.on = (e, f) => { (handlers[e] ||= []).push(f) }
  bot.off = (e, f) => { handlers[e] = (handlers[e] || []).filter(g => g !== f) }
  bot.pathfinder = { setMovements() {}, setGoal() {}, goto() {
    for (const id of [7, 7, 7, 8]) client.emit('position', { teleportId: id, flags: { x: false, y: false, z: false } })
    client.emit('position', { teleportId: 9, flags: { x: true, y: true, z: true } })
    return new Promise(() => {})
  } }
  const message = await walkNear(bot, { x: 5, y: 64, z: 0 }, { dig: false, ...deps(), legTimeoutMs: 50 }).then(() => null, e => e.message)
  assert.match(message, /position packets 5, teleport ids 7-9 \(3 distinct\), 1 relative/)
  assert.equal(client.listenerCount('position'), 0, 'the packet listener is removed after the leg')
})

test('a walk continues past a timed-out leg that closed ground and arrives', async () => {
  const legs = []
  const bot = fakeBot()
  bot.pathfinder = steppingPathfinder(bot, { step: 5, legs })
  const result = await walkNear(bot, { x: 30, y: 64, z: 0 }, { dig: false, ...deps(), timeoutMs: 10000, legTimeoutMs: 50 })
  assert.equal(result.receipt, 'arrived')
  assert.ok(legs.length >= 2, `legs=${legs.length}`)
  assert.equal(Math.floor(bot.entity.position.x), 30)
})

test('a walk continues past a partial path that closed ground, and refuses one that closed none', async () => {
  const legs = []
  const bot = fakeBot()
  bot.pathfinder = steppingPathfinder(bot, { step: 5, legs, resolveEachLeg: true })
  const result = await walkNear(bot, { x: 20, y: 64, z: 0 }, { dig: false, ...deps(), timeoutMs: 10000, legTimeoutMs: 50 })
  assert.equal(result.receipt, 'arrived')
  assert.ok(legs.length >= 2, `legs=${legs.length}`)
  const stuck = fakeBot()
  stuck.pathfinder = steppingPathfinder(stuck, { step: 0, legs: [], resolveEachLeg: true })
  await assert.rejects(() => walkNear(stuck, { x: 20, y: 64, z: 0 }, { dig: false, ...deps(), legTimeoutMs: 50 }), /Navigation ended without reaching the target/)
})

test('a timed-out leg that closed no ground fails as a named Timeout within the leg budget', async () => {
  const bot = fakeBot()
  bot.pathfinder = steppingPathfinder(bot, { step: 0, legs: [] })
  const started = Date.now()
  await assert.rejects(
    () => walkNear(bot, { x: 30, y: 64, z: 0 }, { dig: false, ...deps(), legTimeoutMs: 50 }),
    error => error.name === 'Timeout' && /without closing ground/.test(error.message) && /30 blocks short of 30,64,0/.test(error.message),
  )
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`)
})

test('the whole-walk budget bounds a walk of slow legs and names how far short it stopped', async () => {
  const bot = fakeBot()
  bot.pathfinder = steppingPathfinder(bot, { step: 1.5, legs: [] })
  await assert.rejects(
    () => walkNear(bot, { x: 40, y: 64, z: 0 }, { dig: false, ...deps(), timeoutMs: 120, legTimeoutMs: 50 }),
    /Goto time limit reached \d+ blocks short of 40,64,0\. The straight line is clear/,
  )
})

test('dig refuses to open the floor under the bot over a drop, and allows it over solid ground', async () => {
  const drop = fakeBot({ fills: [[0, 63, 0, stone], [0, 62, 0, lava]] })
  await assert.rejects(
    () => digToward(drop, { kind: 'dig', goal: validateDigGoal({ x: 0, y: 63, z: 0, count: 1 }) }, deps()),
    /0,63,0 has no solid floor under it \(lava\); digging it opens a drop/,
  )
  assert.equal(drop._dug || 0, 0)
  const floor = fakeBot({ fills: [[0, 63, 0, stone], [0, 62, 0, stone]] })
  const result = await digToward(floor, { kind: 'dig', goal: validateDigGoal({ x: 0, y: 63, z: 0, count: 1 }) }, deps())
  assert.equal(result.broken, 1)
})

test('dig refuses a cell with lava beside it, naming where the lava is', async () => {
  const bot = fakeBot({ fills: [[1, 64, 0, stone], [1, 63, 0, stone], [2, 64, 0, lava]] })
  await assert.rejects(
    () => digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()),
    /1,64,0 borders lava at 2,64,0; digging it lets liquid in/,
  )
  assert.equal(bot._dug || 0, 0)
})

test('dig refuses a block that would take longer than its dig budget, naming the tool', async () => {
  const bot = fakeBot({ fills: [[1, 64, 0, stone], [1, 63, 0, stone]] })
  bot.digTime = () => 60000
  await assert.rejects(
    () => digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()),
    /stone at 1,64,0 needs 60s with bare hands; get a better tool/,
  )
  assert.equal(bot._dug || 0, 0)
})

test('a tunnel that meets a too-slow block returns a partial receipt with the reason', async () => {
  const fills = []
  for (let x = 1; x <= 3; x++) fills.push([x, 64, 0, stone], [x, 65, 0, stone], [x, 63, 0, stone])
  const bot = fakeBot({ fills })
  bot.digTime = block => block.position.x >= 2 ? 60000 : 500
  const result = await digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 3, y: 64, z: 0, count: 3 }) }, deps())
  assert.equal(result.broken, 1)
  assert.match(result.reason, /needs 60s .*get a better tool/)
  assert.deepEqual(result.stoppedAt, { x: 2, y: 64, z: 0 })
})

test('a dig the server undoes is not counted and is named', async () => {
  const bot = fakeBot({ fills: [[1, 64, 0, stone], [1, 63, 0, stone]] })
  bot.dig = async () => { bot._dug = (bot._dug || 0) + 1 }
  await assert.rejects(
    () => digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()),
    /the server restored stone at 1,64,0/,
  )
})

test('a primitive receipt without count and item completes with its receipt, not "undefined undefined"', async () => {
  const bot = fakeBot({ fills: [[1, 64, 0, stone], [1, 63, 0, stone]] })
  bot.collectBlock = { movements: {} }
  bot.equip = async () => {}
  const task = { id: 't', kind: 'dig', status: 'running', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }), deadline: Date.now() + 10000 }
  const finished = []
  const runner = Object.assign(Object.create(Runner.prototype), {
    bot, ready: true, task, work: null, movements: null,
    log() {}, persist() {}, say() {}, extend() {},
    finish(status, reason) { finished.push([status, reason]) },
  })
  await runner.runSkill()
  assert.equal(finished.length, 1)
  assert.equal(finished[0][0], 'completed', finished[0][1])
  assert.match(finished[0][1], /dug/)
  assert.doesNotMatch(finished[0][1], /undefined/)
})

test('a leg whose search runs out of time is retried once with the weighted search prospecting uses', async () => {
  // Live, 2026-09-24: goto dig:true and make_obsidian's approach failed with
  // "Took to long to decide path to goal!" in deepslate, while prospecting,
  // which weights its A* heuristic fivefold, tunnelled through the same rock.
  const goals = []
  const bot = fakeBot({
    pathfinder: {
      movements: null, setMovements(m) { this.movements = m }, setGoal() {},
      async goto(goal) {
        goals.push(goal)
        if (goals.length === 1) throw Object.assign(new Error('Took to long to decide path to goal!'), { name: 'Timeout' })
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
      },
    },
  })
  const r = await gotoPosition(bot, { kind: 'goto', goal: validateGotoGoal({ x: 6, y: 64, z: 0, dig: true }) }, deps())
  assert.equal(r.receipt, 'arrived')
  assert.equal(goals.length, 2)
  const node = { x: 0, y: 64, z: 0 }
  assert.ok(goals[1].heuristic(node) >= 4.9 * goals[0].heuristic(node), 'the retry weights the heuristic')
  assert.equal(goals[1].isEnd(new Vec3(6, 64, 0)), true, 'with the same arrival test')
})

test('a wading walk may stand in shallow water; ordinary walks still may not', async () => {
  // Live, 2026-09-24: the tunnel beside the lake held a foot of flowing water,
  // every cell within reach of a source was water, and the fill's approach,
  // which treated all water as a wall, timed out on an unreachable goal.
  const { movementProfile } = await import('../src/primitives.js')
  const bot = fakeBot()
  assert.equal(movementProfile(bot, { dig: true, wade: true }).shallowWaterOnly, true)
  assert.equal(movementProfile(bot, { dig: true }).shallowWaterOnly, false)
  assert.equal(movementProfile(bot, { dig: false }).surfaceWaterOnly, false)
})

// Trial 32 spent portal obsidian on navigation towers despite spare stone.
test('digging movement preserves obsidian while using carried stone for scaffold', async () => {
  const { movementProfile } = await import('../src/primitives.js')
  const { climbBlocks } = await import('../src/burrow.js')
  const bot = fakeBot()
  bot.inventory.items = () => ['obsidian', 'cobblestone'].map(name => ({name, type:registry.itemsByName[name].id, count:10}))
  const movement = movementProfile(bot, {dig:true})
  assert.ok(!movement.scafoldingBlocks.includes(registry.itemsByName.obsidian.id))
  assert.ok(movement.scafoldingBlocks.includes(registry.itemsByName.cobblestone.id))
  assert.equal(climbBlocks(bot),10)
  bot.inventory.items = () => [{name:'obsidian',type:registry.itemsByName.obsidian.id,count:10}]
  assert.equal(climbBlocks(bot),0)
})

test('dig waits for landing before deciding that the carried tool is too slow', async () => {
  const bot = fakeBot({fills:[[1,64,0,stone],[1,63,0,stone]]})
  bot.entity.onGround = false
  bot.digTime = () => bot.entity.onGround ? 9400 : 47000
  const timer = setTimeout(() => {bot.entity.onGround=true},50)
  try {
    const result = await digToward(bot,{kind:'dig',goal:validateDigGoal({x:1,y:64,z:0,count:1})},deps())
    assert.equal(result.broken,1)
  } finally {clearTimeout(timer)}
})


test('dig refuses persistent airborne footing without breaking a block', async () => {
  const bot=fakeBot({fills:[[1,64,0,stone],[1,63,0,stone]]})
  bot.entity.onGround=false
  bot.digTime=()=>47000
  await assert.rejects(()=>digToward(bot,{kind:'dig',goal:validateDigGoal({x:1,y:64,z:0,count:1})},deps()),/stable footing/)
  assert.equal(bot._dug||0,0)
})

test('landing wait remains cancellable', async () => {
  const bot=fakeBot({fills:[[1,64,0,stone],[1,63,0,stone]]})
  bot.entity.onGround=false
  const context=deps()
  let cancelled=false
  context.stage=()=>{cancelled=true}
  context.check=()=>{if(cancelled)throw new Error('cancelled')}
  await assert.rejects(()=>digToward(bot,{kind:'dig',goal:validateDigGoal({x:1,y:64,z:0,count:1})},context),/cancelled/)
  assert.equal(bot._dug||0,0)
})

test('dig never breaks a building block: it says to go around', async () => {
  // The family world is shared with players from 4 October; dig breaks only natural ground.
  const planks = fakeBot({ fills: [[1, 64, 0, { name: 'oak_planks', boundingBox: 'block', diggable: true }], [1, 63, 0, stone]] })
  planks.canDigBlock = eyeReach(planks)
  await assert.rejects(() => digToward(planks, { kind: 'dig', goal: validateDigGoal({ x: 1, y: 64, z: 0, count: 1 }) }, deps()), /oak_planks at 1,64,0 is not natural ground.*Go around it/)
  assert.equal(planks._dug || 0, 0)
  const { isNatural } = await import('../src/natural.js')
  for (const n of ['stone', 'deepslate', 'grass_block', 'gravel', 'iron_ore', 'deepslate_diamond_ore', 'oak_leaves', 'netherrack', 'orange_terracotta', 'crimson_nylium', 'warped_nylium', 'nether_wart_block', 'warped_wart_block', 'glowstone', 'gilded_blackstone', 'nether_gold_ore']) assert.equal(isNatural(n), true, n)
  for (const n of ['oak_planks', 'oak_log', 'cobblestone', 'glass', 'white_wool', 'bricks', 'obsidian', 'chest', 'orange_glazed_terracotta', '', undefined]) assert.equal(isNatural(n), false, String(n))
})

// Honest run 2, 14 October: a fortress-search tunnel at y 75 in the Nether broke into a
// cavern, the bot stepped into the next column, and fell thirty-eight blocks.
test('a tunnel stops at a column with nothing under it instead of stepping into the void', async () => {
  const probe = fakeBot({}), s = probe.entity.position.floored()
  const bot = fakeBot({
    fills: [[s.x + 3, s.y - 1, s.z, { name: 'air', boundingBox: 'empty' }]],
    defaultBlock: p => (p.y < s.y ? stone(p) : { name: 'air', boundingBox: 'empty', position: p }),
  })
  const r = await digToward(bot, { kind: 'dig', goal: validateDigGoal({ x: s.x + 6, y: s.y, z: s.z, count: 6 }) }, deps())
  assert.ok(r.broken >= 1 && r.broken < 6, `stopped short: broke ${r.broken}`)
  assert.match(r.reason || '', /no floor under .* open space/)
  assert.ok(bot.entity.position.x < s.x + 3, `never stood over the hole: x ${bot.entity.position.x}`)
})
