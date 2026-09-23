import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import minecraftData from 'minecraft-data'
import { validatePlan, schema } from '../src/companion/planner.js'
import { validatePlaceAtGoal, validateCollectGoal, validateAttackGoal, placeAt, collectDrops, attackEntity } from '../src/primitives-world.js'
import { EventEmitter } from 'node:events'
import { validateTaskGoal } from '../src/task-store.js'
import { Runner } from '../src/runner.js'

const registry = minecraftData('1.21.4')
const air = p => ({ name: 'air', boundingBox: 'empty', position: p })
const stone = p => ({ name: 'stone', boundingBox: 'block', position: p })
const cobble = p => ({ name: 'cobblestone', boundingBox: 'block', position: p })
const water = p => ({ name: 'water', boundingBox: 'empty', position: p })

const placeStep = (over = {}) => ({ action: 'place_at', name: '', count: 1, item: 'cobblestone', design: [], target: { x: 1, y: 64, z: 0 }, ...over })
const collectStep = (over = {}) => ({ action: 'collect', name: '', count: 2, item: 'raw_iron', design: [], target: null, ...over })

test('validatePlan accepts well-formed place_at and collect steps', () => {
  const p = validatePlan({ reply: 'Bridging.', steps: [placeStep()] })
  assert.deepEqual(p.steps[0], { action: 'place_at', name: '', count: 1, item: 'cobblestone', target: { x: 1, y: 64, z: 0 } })
  const c = validatePlan({ reply: 'Picking up.', steps: [collectStep()] })
  assert.deepEqual(c.steps[0], { action: 'collect', name: '', count: 2, item: 'raw_iron' })
  const any = validatePlan({ reply: 'Picking up.', steps: [collectStep({ item: '' })] })
  assert.deepEqual(any.steps[0], { action: 'collect', name: '', count: 2 })
  assert.deepEqual(validateTaskGoal('place_at', { item: 'dirt', x: 1, y: 2, z: 3 }), { item: 'dirt', x: 1, y: 2, z: 3 })
  assert.deepEqual(validateTaskGoal('collect', { item: '', count: 4 }), { item: '', count: 4 })
})

test('validatePlan rejects malformed place_at and collect steps', () => {
  assert.throws(() => validatePlan({ reply: 'x', steps: [placeStep({ count: 2 })] }), /count 1/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [placeStep({ item: '' })] }), /block item/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [placeStep({ target: null })] }), /integer x, y and z/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [collectStep({ count: 0 })] }), /1–64/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [collectStep({ count: 65 })] }), /1–64/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [collectStep({ target: { x: 1, y: 2, z: 3 } })] }), /no target|accept a target/)
})

test('schema-derived labels exist for place_at and collect', () => {
  const src = readFileSync(new URL('../src/companion/controller.js', import.meta.url), 'utf8')
  const line = src.split('\n').find(l => l.includes('const labels={'))
  for (const action of schema.properties.steps.items.properties.action.enum.filter(a => a !== 'gather_and_return'))
    assert.ok(line.includes(action + ':'), action + ' label')
  assert.ok(schema.properties.steps.items.properties.action.enum.includes('place_at'))
  assert.ok(schema.properties.steps.items.properties.action.enum.includes('collect'))
})

test('place_at and collect pass intent and skill-control admission, and dispatch as skills', async () => {
  const { guardIntent } = await import('../src/companion/intent.js')
  const { SKILL_ACTIONS } = await import('../src/companion/skill-control.js')
  for (const step of [placeStep(), collectStep()]) {
    const plan = validatePlan({ reply: 'ok', steps: [step] })
    assert.deepEqual(guardIntent(plan, 'bridge over and pick up the drops'), plan)
    assert.ok(SKILL_ACTIONS.has(step.action), step.action + ' must be selectable under Jev skill control')
  }
  for (const kind of ['place_at', 'collect']) {
    const calls = []
    const runner = {
      ready: true, connectionId: 'c1',
      task: { kind, status: 'running', goal: { item: 'dirt', x: 1, y: 64, z: 1, count: 1 }, deadline: Date.now() + 10000 },
      bot: { pathfinder: { setGoal: g => calls.push(['navigate', g]) } },
      log: type => calls.push([type]), finish: (s, r) => calls.push(['finish', s, r]), runSkill: () => calls.push(['runSkill']),
    }
    Runner.prototype.applyGoal.call(runner)
    assert.deepEqual(calls, [['runSkill']], `${kind} must run as a skill`)
  }
})

function fakeBot(over = {}) {
  const pos = over.position || new Vec3(0.5, 64, 0.5)
  const world = new Map()
  const set = (x, y, z, block) => { const p = new Vec3(x, y, z); world.set(`${x},${y},${z}`, block(p)) }
  for (const [x, y, z, block] of over.fills || []) set(x, y, z, block)
  const items = over.items || [{ name: 'cobblestone', count: 8, type: registry.itemsByName.cobblestone.id }]
  const bot = {
    entity: { position: pos.clone(), onGround: true },
    entities: over.entities || {},
    registry,
    inventory: { items: () => items },
    pathfinder: {
      setMovements() {}, setGoal() {},
      async goto(goal) { bot.entity.position = new Vec3((goal.x ?? 0) + 0.5, goal.y ?? 64, (goal.z ?? 0) + 0.5); bot._walked = (bot._walked || 0) + 1; over.onArrive?.(bot) },
    },
    equip: async (item) => { bot._held = item.name },
    lookAt: async () => {},
    placeBlock: over.placeBlock || (async (reference, face) => {
      const target = reference.position.plus(face)
      const stack = items.find(i => i.name === bot._held)
      stack.count--
      set(target.x, target.y, target.z, p => ({ name: bot._held, boundingBox: 'block', position: p }))
      bot._placed = { reference: reference.position, face, target }
    }),
    on() {}, off() {}, clearControlStates() {},
  }
  bot.blockAt = p => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    if (world.has(k)) return world.get(k)
    return over.defaultBlock ? over.defaultBlock(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) : air(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
  }
  return bot
}
const deps = () => ({ check() {}, stage() {}, progress() {}, movements: null })
const placeTask = (goal) => ({ kind: 'place_at', goal: validatePlaceAtGoal(goal) })
const collectTask = (goal) => ({ kind: 'collect', goal: validateCollectGoal(goal) })

test('place_at places against a solid neighbour and verifies by re-reading the cell', async () => {
  // Floor under the target only; the bot stands beside it.
  const bot = fakeBot({ fills: [[1, 63, 0, stone], [0, 63, 0, stone]] })
  const r = await placeAt(bot, placeTask({ item: 'cobblestone', x: 1, y: 64, z: 0 }), deps())
  assert.equal(r.receipt, 'placed')
  assert.deepEqual(r.at, { x: 1, y: 64, z: 0 })
  assert.deepEqual(r.against, { x: 1, y: 63, z: 0 })
  assert.equal(r.spent, 1)
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).name, 'cobblestone')
  assert.equal(bot._held, 'cobblestone')
})

test('place_at refuses an occupied cell, a project footprint, a missing item, a non-cube, and a cell with no solid face', async () => {
  const occupied = fakeBot({ fills: [[1, 64, 0, stone], [1, 63, 0, stone]] })
  await assert.rejects(() => placeAt(occupied, placeTask({ item: 'cobblestone', x: 1, y: 64, z: 0 }), deps()), /already holds stone/)
  const project = fakeBot({ fills: [[1, 63, 0, stone]] })
  await assert.rejects(() => placeAt(project, placeTask({ item: 'cobblestone', x: 1, y: 64, z: 0, protectedSites: [{ minX: 0, maxX: 2, minZ: -1, maxZ: 1 }] }), deps()), /saved project footprint/)
  const missing = fakeBot({ fills: [[1, 63, 0, stone]], items: [{ name: 'dirt', count: 3, type: registry.itemsByName.dirt.id }] })
  await assert.rejects(() => placeAt(missing, placeTask({ item: 'cobblestone', x: 1, y: 64, z: 0 }), deps()), /Not carrying cobblestone/)
  const torch = fakeBot({ fills: [[1, 63, 0, stone]], items: [{ name: 'torch', count: 3, type: registry.itemsByName.torch.id }] })
  await assert.rejects(() => placeAt(torch, placeTask({ item: 'torch', x: 1, y: 64, z: 0 }), deps()), /not a full cube.*torches/)
  const floating = fakeBot({})
  await assert.rejects(() => placeAt(floating, placeTask({ item: 'cobblestone', x: 3, y: 66, z: 0 }), deps()), /No solid face.*support block/)
  const wet = fakeBot({ fills: [[1, 63, 0, stone], [1, 64, 0, water]] })
  // Water is replaceable, so this one succeeds; the point is that lava/water do not count as support.
  const r = await placeAt(wet, placeTask({ item: 'cobblestone', x: 1, y: 64, z: 0 }), deps())
  assert.equal(r.receipt, 'placed')
})

test('place_at steps aside when standing in the target, and refuses when there is nowhere to step', async () => {
  // Standing in the target with a floor cell beside it: step onto it, then place.
  const self = fakeBot({ fills: [[0, 63, 0, stone], [1, 63, 0, stone]] })
  const r = await placeAt(self, placeTask({ item: 'cobblestone', x: 0, y: 64, z: 0 }), deps())
  assert.equal(r.receipt, 'placed')
  assert.equal(self._walked, 1, 'one step aside')
  assert.deepEqual([Math.floor(self.entity.position.x), Math.floor(self.entity.position.z)], [1, 0])
  // Standing in the target on a one-block pillar: nowhere to go.
  const pillar = fakeBot({ fills: [[0, 63, 0, stone]] })
  await assert.rejects(() => placeAt(pillar, placeTask({ item: 'cobblestone', x: 0, y: 64, z: 0 }), deps()), /Standing in 0,64,0 with no open cell beside it/)
})

test('place_at walks into reach first when far', async () => {
  // Walking lands the stub in the cell itself, so a floor cell beside it is needed to step onto.
  const far = fakeBot({ fills: [[9, 63, 0, stone], [10, 63, 0, stone]] })
  const r = await placeAt(far, placeTask({ item: 'cobblestone', x: 9, y: 64, z: 0 }), deps())
  assert.equal(r.receipt, 'placed')
  assert.equal(far._walked, 2, 'one walk into reach, one step aside')
})

test('place_at reports an unobserved placement as a failure naming what the cell reads', async () => {
  const bot = fakeBot({ fills: [[1, 63, 0, stone]], placeBlock: async () => {} })
  await assert.rejects(() => placeAt(bot, placeTask({ item: 'cobblestone', x: 1, y: 64, z: 0 }), deps()), /Placed nothing observable.*reads air.*nothing was spent/)
})

function dropEntity(id, name, count, x, y, z) {
  return { id, name: 'item', type: 'object', position: new Vec3(x, y, z), getDroppedItem: () => ({ name, count }) }
}

test('collect walks to the nearest matching drops and reports what it gained', async () => {
  const items = [{ name: 'stone_pickaxe', count: 1, type: 1 }]
  const bot = fakeBot({
    items,
    entities: { 7: dropEntity(7, 'raw_iron', 1, 4.5, 64, 0.5), 8: dropEntity(8, 'raw_iron', 1, 9.5, 64, 0.5), 9: dropEntity(9, 'cobblestone', 3, 2.5, 64, 0.5) },
    onArrive(b) {
      // The server hands over whatever the bot is standing on.
      for (const [id, e] of Object.entries(b.entities)) {
        if (e.position.distanceTo(b.entity.position) < 1.5) {
          const stack = e.getDroppedItem(); const carried = items.find(i => i.name === stack.name)
          if (carried) carried.count += stack.count; else items.push({ name: stack.name, count: stack.count, type: 2 })
          delete b.entities[id]
        }
      }
    },
  })
  const r = await collectDrops(bot, collectTask({ item: 'raw_iron', count: 2 }), deps())
  assert.equal(r.receipt, 'collected')
  assert.equal(r.gained, 2)
  assert.equal(r.requested, 2)
  assert.equal(r.partial, false)
  assert.equal(r.remainingDrops, 0)
  assert.equal(bot._walked, 2, 'nearest first, and never the cobblestone')
  assert.ok(!items.some(i => i.name === 'cobblestone'))
})

test('collect with no matching drops throws naming what else is lying about; collecting nothing is a failure', async () => {
  const none = fakeBot({ entities: { 9: dropEntity(9, 'cobblestone', 3, 2.5, 64, 0.5) } })
  await assert.rejects(() => collectDrops(none, collectTask({ item: 'raw_iron', count: 1 }), deps()), /No dropped raw_iron within 16 blocks; other drops: 3 cobblestone at 2,64,0/)
  // A drop it can stand on but never receives (full inventory) is a failure, not a partial.
  const stuck = fakeBot({ entities: { 7: dropEntity(7, 'raw_iron', 1, 4.5, 64, 0.5) } })
  await assert.rejects(() => collectDrops(stuck, collectTask({ item: 'raw_iron', count: 1 }), deps()), /Collected nothing: saw 1 raw_iron drop, nearest 1 raw_iron at 4,64,0, walked to 1/)
})

const attackStep = (over = {}) => ({ action: 'attack', name: '', count: 1, item: 'zombie', design: [], target: null, ...over })

test('validatePlan accepts a well-formed attack step and rejects player, count 2 and a target', () => {
  const a = validatePlan({ reply: 'Fighting.', steps: [attackStep()] })
  assert.deepEqual(a.steps[0], { action: 'attack', name: '', count: 1, item: 'zombie' })
  assert.deepEqual(validateTaskGoal('attack', { type: 'cow' }), { type: 'cow' })
  assert.throws(() => validatePlan({ reply: 'x', steps: [attackStep({ item: 'player' })] }), /never targets players/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [attackStep({ count: 2 })] }), /count 1/)
  assert.throws(() => validatePlan({ reply: 'x', steps: [attackStep({ target: { x: 1, y: 2, z: 3 } })] }), /no target|accept a target/)
  assert.ok(schema.properties.steps.items.properties.action.enum.includes('attack'))
})

test('attack passes intent and skill-control admission and dispatches as a skill', async () => {
  const { guardIntent } = await import('../src/companion/intent.js')
  const { SKILL_ACTIONS } = await import('../src/companion/skill-control.js')
  const plan = validatePlan({ reply: 'ok', steps: [attackStep({ item: 'cow' })] })
  assert.deepEqual(guardIntent(plan, 'kill a cow for leather'), plan)
  assert.ok(SKILL_ACTIONS.has('attack'))
  const calls = []
  const runner = { ready: true, connectionId: 'c1', task: { kind: 'attack', status: 'running', goal: { type: 'cow' }, deadline: Date.now() + 10000 },
    bot: { pathfinder: { setGoal: g => calls.push(['navigate', g]) } }, log: t => calls.push([t]), finish: (s, r) => calls.push(['finish', s, r]), runSkill: () => calls.push(['runSkill']) }
  Runner.prototype.applyGoal.call(runner)
  assert.deepEqual(calls, [['runSkill']])
})

function fightBot({ entities, health = 20, food = 20, items } = {}) {
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    entities, health, food, registry,
    inventory: { items: () => items || [{ name: 'stone_axe', count: 1, type: registry.itemsByName.stone_axe.id, maxDurability: 131, durabilityUsed: 0 }] },
    pathfinder: { goal: null, setMovements() {}, setGoal(g) { this.goal = g; if (g?.entity) bot.entity.position = g.entity.position.offset(1, 0, 0) } },
    equip: async i => { bot._held = i.name }, lookAt: async () => {}, clearControlStates() {},
    attack: t => { bot._swings = (bot._swings || 0) + 1; bot._hit?.(t) },
  })
  return bot
}
const mob = (id, name, x, y, z) => ({ id, name, type: 'mob', position: new Vec3(x, y, z), height: 1.95 })
const attackTask = type => ({ kind: 'attack', goal: validateAttackGoal({ type }) })

test('attack finds the nearest of the type, swings, and resolves on the server death with drops', async () => {
  const zombie = mob(5, 'zombie', 6.5, 64, 0.5), far = mob(6, 'zombie', 20.5, 64, 0.5), cow = mob(7, 'cow', 2.5, 64, 0.5)
  const items = [{ name: 'stone_axe', count: 1, type: registry.itemsByName.stone_axe.id, maxDurability: 131, durabilityUsed: 0 }]
  const bot = fightBot({ entities: { 5: zombie, 6: far, 7: cow }, items })
  bot._hit = t => { assert.equal(t, zombie); if (bot._swings >= 2) { delete bot.entities[5]; items.push({ name: 'rotten_flesh', count: 1, type: 3 }); bot.emit('entityDead', zombie) } }
  const r = await attackEntity(bot, attackTask('zombie'), deps())
  assert.equal(r.receipt, 'target_death_observed')
  assert.equal(r.type, 'zombie'); assert.equal(r.weapon, 'stone_axe'); assert.equal(r.swings, 2); assert.equal(r.reacquired, 0)
  assert.deepEqual({ ...r.drops }, { rotten_flesh: 1 })
  assert.equal(bot._held, 'stone_axe')
})

test('attack re-acquires the same type nearby when the tracked entity vanishes (enderman)', async () => {
  const first = mob(11, 'enderman', 5.5, 64, 0.5)
  const bot = fightBot({ entities: { 11: first } })
  let swings = 0
  bot._hit = t => {
    swings++
    if (swings === 1) { delete bot.entities[11]; const again = mob(12, 'enderman', bot.entity.position.x + 4, 64, 0.5); bot.entities[12] = again }
    if (swings === 3) { const cur = bot.entities[12]; delete bot.entities[12]; bot.emit('entityDead', cur) }
  }
  const r = await attackEntity(bot, attackTask('enderman'), deps())
  assert.equal(r.receipt, 'target_death_observed'); assert.equal(r.reacquired, 1); assert.equal(r.swings, 3)
})

test('attack refuses at low health, throws when none of the type is loaded, and breaks off when health falls', async () => {
  await assert.rejects(() => attackEntity(fightBot({ entities: { 5: mob(5, 'zombie', 3.5, 64, 0.5) }, health: 7 }), attackTask('zombie'), deps()), /Health 7 is below 8; eat or shelter/)
  await assert.rejects(() => attackEntity(fightBot({ entities: { 7: mob(7, 'cow', 3.5, 64, 0.5), 8: mob(8, 'sheep', 9.5, 64, 0.5) } }), attackTask('zombie'), deps()), /No zombie within 24 blocks; nearest loaded entities: cow 3, sheep 9/)
  const zombie = mob(5, 'zombie', 3.5, 64, 0.5)
  const hurt = fightBot({ entities: { 5: zombie } })
  hurt._hit = () => { hurt.health = 5 }
  await assert.rejects(() => attackEntity(hurt, attackTask('zombie'), deps()), /Health 5: broke off the attack on the zombie after 1 swings; shelter or eat/)
  // A lost target with nothing of its type nearby is a named failure, not a hang.
  const gone = fightBot({ entities: { 5: mob(5, 'zombie', 3.5, 64, 0.5) } })
  gone._hit = () => { delete gone.entities[5] }
  await assert.rejects(() => attackEntity(gone, attackTask('zombie'), deps()), /Lost the zombie.*none within 8 blocks.*1 swings landed, no kill confirmed/)
})
