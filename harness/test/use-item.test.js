import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from '../src/companion/planner.js'
import { validateUseStep, useHeldItem, validateUseGoal, parseBlockState, matchesExpected } from '../src/use-item.js'
import { Vec3 } from 'vec3'
import { validateGoal } from '../src/task-store.js'
import { stepKey } from '../src/companion/progress.js'

// The step the planner will emit to light a nether portal. Five target keys:
// x/y/z say where the effect must land, `how` picks click-a-block or point-in-air,
// and `dimension` exists because the task-store bounds admit an Overworld
// coordinate in the Nether, where it resolves to real, loaded netherrack.
export const useStep = (over = {}) => ({
  action: 'use', name: 'nether_portal', count: 1, item: 'flint_and_steel', design: [],
  target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' }, ...over,
})
export const usePlan = (over = {}) => ({ reply: 'Lighting the portal.', steps: [useStep(over)] })

test('a use step survives validation and normalization with all five target keys', () => {
  assert.deepEqual(validatePlan(usePlan()).steps[0], {
    action: 'use', name: 'nether_portal', count: 1, item: 'flint_and_steel',
    target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' },
  }, 'the normalised step keeps all five target keys and drops design')
  // Normalisation is idempotent: a plan already in normalised shape round-trips,
  // which is what test/companion.test.js asserts for every other action.
  const plan = { reply: 'Lighting the portal.', steps: [{ action: 'use', name: 'nether_portal', count: 1, item: 'flint_and_steel', target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' } }] }
  assert.deepEqual(validatePlan(plan), plan)
})

test('use refuses a plan that batches more than one interaction into a step', () => {
  // One use, one receipt. A plan carries at most eight steps, so a long sequence
  // spans planning rounds; it is never compressed into a count.
  assert.throws(() => validatePlan(usePlan({ count: 2 })), /at most eight steps/)
  assert.throws(() => validatePlan(usePlan({ design: [{ x: 0, y: 0, z: 0, block: 'stone' }] })), /carries no design/)
  assert.throws(() => validatePlan(usePlan({ target: { x: 1, y: 2, z: 3 } })), /how "click" or "point"/)
  assert.throws(() => validatePlan(usePlan({ target: { x: 1, y: 2, z: 3, how: 'point', dimension: 'overworld' } })), /pointed use cannot declare/)
})

test('use bounds match the task-store goal bounds exactly', () => {
  // use-item deliberately duplicates task-store's bounds rather than importing
  // them, because task-store imports use-item and the cycle would be worse.
  // This makes the duplication visible instead of letting it drift.
  for (const p of [{ x: 0, y: -65, z: 0 }, { x: 0, y: 321, z: 0 }, { x: 30000000, y: 64, z: 0 }, { x: 0, y: 64, z: 30000000 }]) {
    assert.throws(() => validateGoal(p), /outside supported bounds/, `task-store rejects ${JSON.stringify(p)}`)
    assert.throws(() => validateUseStep({ item: 'flint_and_steel', count: 1, name: '', target: { ...p, how: 'click', dimension: 'overworld' } }), /outside supported/, `use rejects ${JSON.stringify(p)}`)
  }
  const inside = { x: 12, y: 65, z: -7 }
  assert.deepEqual(validateGoal(inside), inside)
  assert.doesNotThrow(() => validateUseStep({ item: 'flint_and_steel', count: 1, name: '', target: { ...inside, how: 'click', dimension: 'overworld' } }))
})

test('a use step passes the intent boundary and is available under Jev skill control', async () => {
  const { guardIntent } = await import('../src/companion/intent.js')
  const { SKILL_ACTIONS } = await import('../src/companion/skill-control.js')
  const plan = validatePlan(usePlan())
  assert.deepEqual(guardIntent(plan, 'light the portal'), plan, 'intent does not strip the new action')
  assert.ok(SKILL_ACTIONS.has('use'), 'Jev skill control can select it, or the action silently vanishes in that mode')
})

test('stepKey distinguishes two uses at different coordinates', () => {
  // Without the target in the key, inserting twelve eyes reads as one repeated
  // step and the repeat guard refuses the second frame.
  const a = validatePlan(usePlan()).steps[0]
  const b = validatePlan(usePlan({ target: { x: 13, y: 65, z: -7, how: 'click', dimension: 'overworld' } })).steps[0]
  assert.notEqual(stepKey(a), stepKey(b))
})

// A bot mock that counts every way a packet could leave. Any test asserting a
// refusal asserts these stay at zero: "refused before the packet" is the whole
// safety property, and a refusal that still sent something is not a refusal.
export function fakeBot(over = {}) {
  const sent = { place: 0, activate: 0, equip: 0, dig: 0 }
  const bot = {
    sent,
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(12.5, 65, -6.5) },
    heldItem: { name: 'flint_and_steel', count: 1 },
    currentWindow: null,
    players: {},
    inventory: { items: () => [{ name: 'flint_and_steel', count: 1, maxDurability: 64, durabilityUsed: 0 }] },
    registry: { itemsByName: Object.fromEntries(['flint_and_steel','ender_eye','bone_meal','water_bucket','bucket','shears','oak_sapling','wheat_seeds'].map(n=>[n,{id:1}])), blocksByName: {} },
    blockAt: () => ({ name: 'air', shapes: [], getProperties: () => ({}) }),
    _genericPlace: async () => { sent.place++ },
    activateItem: () => { sent.activate++ },
    deactivateItem: () => {},
    equip: async () => { sent.equip++ },
    dig: async () => { sent.dig++ },
    lookAt: async () => {},
    waitForTicks: async () => {},
    ...over,
  }
  // The pathfinder goal constructors read the world directly, so the stub has to
  // answer getBlock the same way blockAt does.
  bot.world = { getBlock: p => bot.blockAt(p), raycast: () => null, ...(over.world || {}) }
  return bot
}
const defaultApproach = () => ({ ref: new Vec3(12, 64, -7), face: new Vec3(0, -1, 0), to: new Vec3(12.5, 65, -6.5) })
const deps = () => ({ check() {}, walk: async () => {}, stage() {}, persist() {}, approach: defaultApproach, settle: async (fn, msg) => { if (!fn()) throw new Error(msg) } })
const useTask = (over = {}) => ({ kind: 'use', goal: { item: 'flint_and_steel', count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' }, ...over } })

test('a use refuses a target in another dimension before sending anything', async () => {
  // task-store's bounds admit an Overworld coordinate in the Nether, where it
  // resolves to real loaded netherrack. Without this the agent reads the wrong
  // world's block, approaches it, clicks, and sets the Nether on fire.
  const bot = fakeBot({ game: { dimension: 'the_nether' } })
  await assert.rejects(() => useHeldItem(bot, useTask(), deps()), /the_nether/)
  assert.equal(bot.sent.place, 0, 'no packet left the client')
  assert.equal(bot.sent.activate, 0)
})

test('a use refuses an unloaded target and names the recovery', async () => {
  // No proof site, no packet. This is what makes a silent no-op impossible by
  // construction rather than by diligence.
  const bot = fakeBot({ blockAt: () => null })
  await assert.rejects(() => useHeldItem(bot, useTask(), deps()), /not loaded[\s\S]*Travel within 32/)
  assert.equal(bot.sent.place, 0)
})

test('use refuses a full solid block, an oriented placement and a workstation, and accepts a sapling and seeds', async () => {
  const { default: minecraftData } = await import('minecraft-data')
  const registry = minecraftData('1.21.4')
  const run = item => useHeldItem(fakeBot({ registry, inventory: { items: () => [{ name: item, count: 1 }] } }), useTask({ item }), deps())
  for (const [item, why] of [['oak_planks', /full solid block/], ['obsidian', /full solid block/], ['oak_door', /oriented placement/], ['white_bed', /oriented placement/], ['torch', /oriented placement/], ['chest', /base workstation/]])
    await assert.rejects(() => run(item), why, `${item} must be refused`)
  // The accepted set is the point: a block-name refusal would have killed
  // saplings and seeds, which are exactly the cases `use` exists to serve.
  const guardMessage = /full solid block|oriented placement|base workstation|unavailable in this version/
  for (const item of ['oak_sapling', 'wheat_seeds', 'flint_and_steel', 'ender_eye', 'bone_meal', 'shears'])
    await assert.rejects(() => run(item), e => !guardMessage.test(e.message), `${item} must pass the item guards`)
})

test('point mode is refused for anything but a bucket', async () => {
  const { default: minecraftData } = await import('minecraft-data')
  const registry = minecraftData('1.21.4')
  const point = item => ({ item, count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'point', dimension: 'overworld' } })
  const bot = fakeBot({ registry, inventory: { items: () => [{ name: 'ender_eye', count: 1 }] } })
  // EnderEyeItem.use() throws the eye as a locator projectile. A silent
  // fall-through to point mode would hurl an irreplaceable item into the sky.
  await assert.rejects(() => useHeldItem(bot, { kind: 'use', goal: point('ender_eye') }, deps()), /not a block interaction/)
  assert.equal(bot.sent.activate, 0)
  const wb = fakeBot({ registry, inventory: { items: () => [{ name: 'water_bucket', count: 1 }] } })
  await assert.rejects(() => useHeldItem(wb, { kind: 'use', goal: point('water_bucket') }, deps()), e => !/not a block interaction/.test(e.message), 'a bucket passes the gate')
})

test('a use refuses an effect cell inside a saved project footprint', async () => {
  const bot = fakeBot()
  await assert.rejects(() => useHeldItem(bot, useTask({ protectedSites: [{ minX: 0, maxX: 20, minZ: -20, maxZ: 0 }] }), deps()), /saved project/)
  assert.equal(bot.sent.place, 0)
  assert.throws(() => validateUseGoal({ item: 'flint_and_steel', count: 1, expect: '', target: { x: 1, y: 2, z: 3, how: 'click', dimension: 'overworld' }, protectedSites: [{ minX: 5, maxX: 1, minZ: 0, maxZ: 2 }] }), /protected construction rectangle/)
})

test('an already satisfied expectation spends nothing and sends nothing', async () => {
  // One predicate, two jobs: the same expectation proves idempotence before the
  // interaction and produces the receipt after it. This is what lets a replan
  // walk twelve end portal frames without spending an eye on a filled one.
  const bot = fakeBot({ blockAt: () => ({ name: 'end_portal_frame', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ eye: true, facing: 'north' }) }) })
  const result = await useHeldItem(bot, useTask({ item: 'flint_and_steel', expect: 'end_portal_frame[eye=true]' }), deps())
  assert.equal(result.receipt, 'use_already_satisfied')
  assert.equal(bot.sent.equip, 0, 'nothing equipped')
  assert.equal(bot.sent.place, 0, 'nothing sent')
})

test('block state expectations parse and match by property, not by name alone', () => {
  // properties is a null-prototype object so a state literally named __proto__
  // cannot reach Object.prototype; spread it to compare.
  assert.equal(parseBlockState('end_portal_frame[eye=true]').block, 'end_portal_frame')
  assert.deepEqual({ ...parseBlockState('end_portal_frame[eye=true]').properties }, { eye: 'true' })
  assert.deepEqual({ ...parseBlockState('nether_portal').properties }, {})
  assert.throws(() => parseBlockState('Not A Block'), /block ID/)
  const frame = s => ({ name: 'end_portal_frame', getProperties: () => ({ eye: s }) })
  assert.equal(matchesExpected(frame(true), parseBlockState('end_portal_frame[eye=true]')), true, 'booleans are coerced to strings')
  assert.equal(matchesExpected(frame(false), parseBlockState('end_portal_frame[eye=true]')), false)
  // Every companion-test bot mock defines blockAt without getProperties, so the
  // optional-call guard is load-bearing, not cosmetic.
  assert.equal(matchesExpected({ name: 'end_portal_frame' }, parseBlockState('end_portal_frame[eye=true]')), false)
  assert.equal(matchesExpected(null, parseBlockState('nether_portal')), false)
})

// A world whose cells can change, so a receipt can be driven from an actual diff
// rather than from a stub that agrees with itself.
function scene(cells, inv = [{ name: 'flint_and_steel', count: 1, maxDurability: 64, durabilityUsed: 0 }]) {
  const at = p => cells[`${p.x},${p.y},${p.z}`] ?? { name: 'air', shapes: [], getProperties: () => ({}) }
  const bot = fakeBot({ blockAt: at, inventory: { items: () => inv } })
  bot.cells = cells
  return bot
}
const cell = (name, props = {}, shapes = [[0, 0, 0, 1, 1, 1]]) => ({ name, shapes, getProperties: () => props })
const air = { name: 'air', shapes: [], getProperties: () => ({}) }
const approachStub = () => ({ ref: new Vec3(12, 64, -7), face: new Vec3(0, -1, 0), to: new Vec3(12.5, 65, -6.5) })

test('the aim is chosen by the target cell, not by the item', async () => {
  // An item table would have to know what every item aims at. The cell knows.
  const calls = []
  const spy = (over, item = 'flint_and_steel') => {
    const bot = scene(over, [{ name: item, count: 1, maxDurability: 64, durabilityUsed: 0 }])
    bot._genericPlace = async (block, face, opts) => { calls.push({ block: block.name, face: [face.x + 0, face.y + 0, face.z + 0], delta: opts?.delta ? [opts.delta.x, opts.delta.y, opts.delta.z] : null }); bot.sent.place++ }
    return bot
  }
  // air target: click the neighbour that supports it, on the face pointing in
  const a = spy({})
  await useHeldItem(a, useTask(), { ...deps(), approach: approachStub }).catch(() => {})
  assert.equal(calls[0].block, 'air', 'the air branch clicks the reference block it was given')
  assert.deepEqual(calls[0].face, [0, 1, 0], 'the support face is inverted to point into the cell')
  assert.ok(calls[0].delta, 'an absolute shape-face centre becomes a 0..1 cursor')
  // solid target: raycast for the face actually hit
  calls.length = 0
  const b = spy({ '12,65,-7': cell('end_portal_frame', { eye: false }) }, 'ender_eye')
  b.world.raycast = () => ({ face: 1, intersect: new Vec3(12.5, 66, -6.5) })
  await useHeldItem(b, useTask({ item: 'ender_eye' }), { ...deps(), approach: approachStub }).catch(() => {})
  assert.equal(calls[0].block, 'end_portal_frame')
  assert.deepEqual(calls[0].face, [0, 1, 0], 'FACE[hit.face] is used, not a guess')
  // shapeless non-air: no collision shape, so no raycast can ever land
  calls.length = 0
  const c = spy({ '12,65,-7': cell('wheat', { age: 3 }, []) }, 'bone_meal')
  await useHeldItem(c, useTask({ item: 'bone_meal' }), { ...deps(), approach: approachStub }).catch(() => {})
  assert.equal(calls[0].block, 'wheat')
  assert.equal(calls[0].delta, null, 'no cursor: a shapeless cell has no face to aim at')
})

test('a point use out of reach is refused before the packet', async () => {
  // A lava bucket pointed at a cell ten blocks away lands lava at the bot's feet
  // and reports success. The server raycasts 4.5 blocks; so must we.
  const bot = scene({}, [{ name: 'water_bucket', count: 1 }])
  bot.entity.position = new Vec3(0.5, 65, 0.5)
  await assert.rejects(() => useHeldItem(bot, { kind: 'use', goal: { item: 'water_bucket', count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'point', dimension: 'overworld' } } }, deps()), /Cannot reach/)
  assert.equal(bot.sent.activate, 0)
})

test('a use that changes nothing and spends nothing fails and clears the latch; a spend with no readable effect is partial and holds it', async () => {
  // The asymmetry is deliberate. Nothing happened means a different aim is free.
  // Something happened that we could not read means a repeat might destroy it.
  const nothing = scene({})
  const t1 = useTask()
  await assert.rejects(() => useHeldItem(nothing, t1, { ...deps(), approach: approachStub }), /nothing/i)
  assert.equal(t1.use?.uncertain, false, 'latch cleared: we know nothing happened')

  let used = 0
  const spent = scene({})
  spent.inventory = { items: () => [{ name: 'flint_and_steel', count: 1, maxDurability: 64, durabilityUsed: used }] }
  spent._genericPlace = async () => { spent.sent.place++; used = 1 }
  const t2 = useTask()
  const r = await useHeldItem(spent, t2, { ...deps(), approach: approachStub })
  assert.equal(r.receipt, 'use_effect_unobserved')
  assert.equal(r.partial, true)
  assert.equal(t2.use.uncertain, true, 'latch held: something was spent and we cannot see what it did')
})

test('a failed ignition reports the block it actually got and puts the fire out', async () => {
  // "Accurate and unrecoverable" is the climb-on-a-pillar shape. Leaving a fire
  // burning next to a wooden base because the expectation failed is that shape.
  const bot = scene({})
  bot._genericPlace = async () => { bot.sent.place++; bot.cells['12,65,-7'] = cell('fire', {}, []) }
  await assert.rejects(() => useHeldItem(bot, useTask({ expect: 'nether_portal' }), { ...deps(), approach: approachStub }),
    /expected nether_portal[\s\S]*observed fire/)
  assert.equal(bot.sent.dig, 1, 'the fire it started is put out')
})

test('a bucket empty is not proven by the spend alone', async () => {
  // The OR rule reports success for a pour that landed anywhere, including a
  // Nether water bucket that evaporates the same tick. Requiring the diff
  // classifies that correctly, without a dimension special case.
  let inv = [{ name: 'water_bucket', count: 1 }]
  const bot = scene({})
  bot.inventory = { items: () => inv }
  bot.entity.position = new Vec3(12.5, 65, -6.5)
  bot.activateItem = () => { bot.sent.activate++; inv = [{ name: 'bucket', count: 1 }] }
  const r = await useHeldItem(bot, { kind: 'use', goal: { item: 'water_bucket', count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'point', dimension: 'overworld' } } }, deps())
  assert.equal(r.receipt, 'use_effect_unobserved', 'transmutation alone is not proof the water landed')
  assert.equal(r.partial, true)
})

test('a container that opens during a use is closed and the use fails', async () => {
  // A leaked window poisons eatFood and the defence decision.
  let closes = 0
  const bot = scene({})
  bot.closeWindow = () => { closes++; bot.currentWindow = null }
  bot._genericPlace = async () => { bot.sent.place++; bot.currentWindow = { id: 1 } }
  await assert.rejects(() => useHeldItem(bot, useTask(), { ...deps(), approach: approachStub }), /belong to the base actions/)
  assert.equal(closes, 1)
})

test('mineflayer still exposes the private placement primitive use depends on', async () => {
  // `use` is this codebase's first direct consumer of a private mineflayer API.
  // bot.placeBlock cannot serve: place_block.js asserts the block TYPE changed,
  // and an eye insertion only flips end_portal_frame's `eye` property, so it
  // would throw on a successful insertion. This is the CI tripwire so a
  // mineflayer bump fails here rather than on the one continuing world.
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const path = createRequire(import.meta.url).resolve('mineflayer/lib/plugins/generic_place.js')
  const src = readFileSync(path, 'utf8')
  assert.match(src, /bot\._genericPlace\s*=/, 'mineflayer no longer attaches _genericPlace; see use-item.js for the activateBlock(block,face,cursor) fallback')
  assert.match(src, /async function _genericPlace \(referenceBlock, faceVector, options\)/, 'the signature use-item.js calls has changed')
})

// --- Phase D: the controller ---
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Teammate } from '../src/companion/controller.js'

class UseRunner extends EventEmitter {
  constructor(result) {
    super()
    this.profile = 'lab'; this.owner = 'Sov'; this.ready = true; this.commands = []; this.result = result
    this.bot = { players: { Sov: { entity: { position: { x: 1, y: 64, z: 2 } } } }, inventory: { items: () => [] } }
  }
  position() { return { x: 0, y: 64, z: 0 } }
  command(c) {
    this.emit('operator_command', c); this.commands.push(c)
    this.task = { id: String(this.commands.length), kind: c.action, goal: c.goal, status: 'running' }
    if (c.action === 'stop' || c.action === 'follow') return
    const outcome = c.action === 'use' ? this.result : {}
    setTimeout(() => {
      if (outcome instanceof Error) { this.task = { ...this.task, status: 'failed', reason: outcome.message }; this.emit('event', { type: 'task_finished', task: this.task }) }
      else { this.task = { ...this.task, status: 'completed', result: outcome }; this.emit('event', { type: 'task_finished', task: this.task }) }
    }, 1)
  }
}
const useSetup = (plan, result) => {
  const r = new UseRunner(result)
  return [r, new Teammate(r, { model: 'fake', plan }, join(mkdtempSync(join(tmpdir(), 'mc-use-')), 'state.json'))]
}
const oneUse = () => ({ reply: 'Lighting it.', steps: [useStep()] })

test('a completed use carries its receipt into feedback', async () => {
  // Without `use` in the controller's result list the receipt is dropped and the
  // planner gets a bare "completed" with nothing to reason from.
  let calls = 0
  const [r, c] = useSetup(async () => ++calls === 1 ? oneUse() : { reply: 'Done.', steps: [] },
    { item: 'flint_and_steel', receipt: 'use_effect_observed', observed: { name: 'nether_portal', state: {} }, changed: [] })
  await c.submit('light the portal')
  assert.equal(r.commands.filter(x => x.action === 'use').length, 1, 'the controller dispatched a use command')
  const fb = (c.requestProgress.feedback || []).filter(f => f.action === 'use')
  assert.equal(fb.at(-1)?.result?.receipt, 'use_effect_observed', 'the receipt reaches the planner')
})

test('a failed use gets another planning round, and a recovered one does not end blocked', async () => {
  // The point of the adaptive list is that the model can read its own refusal.
  // Without `use` in it the first failure throws outright and there is no next
  // round in which to read anything.
  let calls = 0, outcome = new Error('Use of flint_and_steel at 12, 65, -7 changed nothing observable and spent nothing')
  const r = new UseRunner(null)
  Object.defineProperty(r, 'result', { get: () => outcome })
  const c = new Teammate(r, { model: 'fake', plan: async () => {
    if (++calls === 1) return oneUse()
    if (calls === 2) { outcome = { item: 'flint_and_steel', receipt: 'use_effect_observed', observed: { name: 'nether_portal', state: {} }, changed: [] }
      return { reply: 'Aiming at the other face.', steps: [useStep({ target: { x: 13, y: 65, z: -7, how: 'click', dimension: 'overworld' } })] } }
    return { reply: 'Lit.', steps: [] }
  } }, join(mkdtempSync(join(tmpdir(), 'mc-use-')), 'state.json'))
  await c.submit('light the portal')
  assert.ok(calls >= 2, 'a second planning round ran so the model can read its own refusal')
  assert.equal(r.commands.filter(x => x.action === 'use').length, 2, 'it tried again with a different aim')
  assert.notEqual(c.requestProgress.status, 'blocked', 'the recovered request is not left blocked')
})

test('a pure-use round with no contract keeps planning instead of reporting finished', async () => {
  // A partial use is unresolved by definition. Reporting "Finished." after one
  // is the confident-false-success this whole receipt design exists to prevent.
  let calls = 0
  const [, c] = useSetup(async () => ++calls === 1 ? oneUse() : { reply: 'Re-observing.', steps: [] },
    { item: 'flint_and_steel', receipt: 'use_effect_unobserved', partial: true, observed: { name: 'air', state: {} }, changed: [] })
  await c.submit('light the portal')
  assert.ok(calls >= 2, 'the partial use bought another round')
  assert.ok(!c.messages.some(m => /^Finished\./.test(m.text)), `must not report finished: ${JSON.stringify(c.messages.map(m => m.text))}`)
})

test('a second use at the same target after a partial is refused; a different target is allowed', async () => {
  // Keyed on a COMPLETED entry's receipt. The first version of this guard keyed
  // on a failed entry's task, which the controller never attaches for `use`,
  // so it was dead code that three reviewers caught independently.
  let calls = 0, seen = []
  const r = new UseRunner({ item: 'flint_and_steel', receipt: 'use_effect_unobserved', partial: true, target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' }, observed: { name: 'air', state: {} }, changed: [] })
  const c = new Teammate(r, { model: 'fake', plan: async () => {
    calls++
    if (calls === 1) return oneUse()
    if (calls === 2) return oneUse()                                  // same target: must be refused
    if (calls === 3) return { reply: 'Other frame.', steps: [useStep({ target: { x: 13, y: 65, z: -7, how: 'click', dimension: 'overworld' } })] }
    return { reply: 'Done.', steps: [] }
  } }, join(mkdtempSync(join(tmpdir(), 'mc-use-')), 'state.json'))
  await c.submit('light the portal')
  seen = r.commands.filter(x => x.action === 'use').map(x => `${x.goal.target.x}`)
  assert.ok(c.messages.some(m => /charged without a confirmed effect/.test(m.text)), 'the repeat at the same target is refused by name')
  assert.ok(seen.includes('13'), 'a different target is still allowed')
})

test('an interrupted use requires review before an automatic resume', async () => {
  const { interruptedEffect } = await import('../src/companion/continuity.js')
  assert.equal(typeof interruptedEffect({ use: { uncertain: true } }), 'string', 'an in-flight use blocks automatic resume')
  assert.equal(interruptedEffect({ use: { uncertain: false } }), null, 'a resolved one does not')
})

test('the interactables channel reports goal-named blocks and the nearest fluid source', async () => {
  const { interactableObservation, useTargetNames } = await import('../src/use-item.js')
  // A bucket can only fill from a source cell (level=0). The nearest water is
  // usually flowing, and reporting it would send the agent to fill from a
  // stream it cannot fill from.
  const names = { obsidian: 1, water: 2, farmland: 3, wheat: 4 }
  const cells = {
    '1,64,0': { name: 'water', getProperties: () => ({ level: 3 }) },
    '2,64,0': { name: 'water', getProperties: () => ({ level: 1 }) },
    '9,64,0': { name: 'water', getProperties: () => ({ level: 0 }) },
    '3,64,0': { name: 'obsidian', getProperties: () => ({}) },
  }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: Object.fromEntries(Object.entries(names).map(([n, id]) => [n, { id }])) },
    blockAt: p => cells[`${p.x},${p.y},${p.z}`] ?? null,
    findBlocks: ({ matching }) => Object.entries(cells).filter(([, b]) => names[b.name] === matching)
      .map(([k]) => new Vec3(...k.split(',').map(Number))),
  }
  const o = interactableObservation(bot, { names: ['obsidian', 'water'] })
  assert.ok(o.blocks.some(b => b.name === 'obsidian'), 'declared names are scanned')
  assert.deepEqual([o.nearestSource.water.x, o.nearestSource.water.y, o.nearestSource.water.z], [9, 64, 0],
    'the source cell, not the nearer flowing one')
  // A goal naming a block in a block_at criterion puts it in the scan.
  assert.ok(useTargetNames({ criteria: [{ kind: 'block_at', item: 'wheat', target: '', count: 1 }] }).includes('wheat'))
  assert.ok(useTargetNames(null).includes('obsidian'), 'the defaults stand alone with no goal')
})

test('the observation reports which dimension the agent is in', async () => {
  const { survivalObservation } = await import('../src/survival.js')
  const bot = { game: { dimension: 'minecraft:the_nether' }, entity: { position: new Vec3(0, 64, 0), effects: {} },
    health: 20, food: 20, foodSaturation: 0, oxygenLevel: 20, time: { timeOfDay: 0 }, entities: {}, inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }), registry: { blocksByName: {} } }
  // dimension must reach the planner: a coordinate means nothing in the wrong world.
  assert.equal(survivalObservation(bot).dimension, 'the_nether', 'the minecraft: prefix is stripped')
})

test('the capabilities brief teaches use as a mechanism, not a portal recipe', async () => {
  // The whole point of one verb is that it generalises. A brief that only ever
  // says "flint and steel" teaches the planner a recipe, and the next six rungs
  // each get their own hand-written skill again.
  const { readFileSync } = await import('node:fs')
  const brief = readFileSync(new URL('../src/companion/survival-capabilities.txt', import.meta.url), 'utf8')
  const para = brief.split('\n').filter(l => /Action use:|how="click"|how="point"|name is the block|observation\.interactables/.test(l)).join('\n')
  assert.ok(para, 'the use paragraph exists')
  const families = ['flint_and_steel', 'ender_eye', 'bone_meal', 'shears', 'bucket', 'sapling'].filter(f => para.includes(f))
  assert.ok(families.length >= 4, `names at least four item families, found ${JSON.stringify(families)}`)
  assert.match(para, /how="click"/, 'both modes are taught')
  assert.match(para, /how="point"/)
  assert.match(para, /dimension must match survival\.dimension/, 'the dimension rule is stated, not implied')
})

test('the executor refuses to repeat its own unresolved use, not just the controller', async () => {
  // The controller guard reads feedback; a task restored from disk after a
  // restart has no feedback, and controller.js:61,70 auto-restore it. The latch
  // lives on the task itself, so the executor must honour it too.
  const bot = scene({})
  const t = { kind: 'use', goal: { item: 'flint_and_steel', count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' } },
    use: { item: 'flint_and_steel', target: { x: 12, y: 65, z: -7, how: 'click', dimension: 'overworld' }, uncertain: true } }
  await assert.rejects(() => useHeldItem(bot, t, deps()), /charged without a confirmed effect/)
  assert.equal(bot.sent.place, 0, 'refused before the packet')
  // A different cell is unaffected: the latch guards the one place that might
  // be destroyed by a repeat, not the item in general.
  const ok = { ...t, goal: { ...t.goal, target: { x: 13, y: 65, z: -7, how: 'click', dimension: 'overworld' } } }
  await assert.rejects(() => useHeldItem(scene({}), ok, deps()), e => !/charged without a confirmed effect/.test(e.message))
})

test('the spend channel sees damage when several copies of a durable item are carried', async () => {
  // Durable items do not stack, so carrying four flint and steels means four
  // slots. Reading one arbitrary slot missed the damage entirely: the live
  // portal lab reported durability 64 -> 64 while the server had charged one.
  // Flint and steel changes no inventory COUNT, so durability is the only
  // second witness the most important use in the tree has.
  let used = 0
  const bot = scene({})
  bot.inventory = { items: () => [
    { name: 'flint_and_steel', count: 1, maxDurability: 64, durabilityUsed: 0 },
    { name: 'flint_and_steel', count: 1, maxDurability: 64, durabilityUsed: used },
    { name: 'flint_and_steel', count: 1, maxDurability: 64, durabilityUsed: 0 },
  ] }
  bot._genericPlace = async () => { bot.sent.place++; used = 1 }
  const t = useTask()
  const r = await useHeldItem(bot, t, { ...deps(), approach: defaultApproach })
  assert.equal(r.receipt, 'use_effect_unobserved', 'charged but no visible change')
  assert.ok(r.spent.durabilityAfter < r.spent.durabilityBefore,
    `the damage must be visible: ${r.spent.durabilityBefore} -> ${r.spent.durabilityAfter}`)
})

test('a pointed use lets the look reach the server before the item is used', async () => {
  // Point mode makes the SERVER raycast along the look vector. lookAt and
  // activateItem in the same tick let the server raycast on the PREVIOUS
  // orientation, which made bucket fill intermittently do nothing on a real
  // server: it worked, then did not, then did. Ordering, not luck.
  const order = []
  const bot = scene({}, [{ name: 'water_bucket', count: 1 }])
  bot.entity.position = new Vec3(12.5, 65, -6.5)
  bot.lookAt = async () => { order.push('look') }
  bot.waitForTicks = async () => { order.push('tick') }
  bot.activateItem = () => { order.push('activate'); bot.sent.activate++ }
  bot.deactivateItem = () => { order.push('deactivate') }
  await useHeldItem(bot, { kind: 'use', goal: { item: 'water_bucket', count: 1, expect: '',
    target: { x: 12, y: 65, z: -7, how: 'point', dimension: 'overworld' } } }, deps()).catch(() => {})
  assert.deepEqual(order, ['look', 'tick', 'activate', 'deactivate'],
    `the look must be settled before the use: ${JSON.stringify(order)}`)
})

test('filling a bucket is proven by the bucket, never by water moving nearby', async () => {
  // Trial 24: make_obsidian's fill "succeeded" three times at a pool of flowing
  // water and the bucket stayed empty. Levels in the cells around the target
  // change on their own every tick, and any change counted as the effect.
  let inv = [{ name: 'bucket', count: 1 }]
  const bot = scene({ '12,65,-7': cell('water', { level: 0 }, []) })
  bot.inventory = { items: () => inv }
  bot.entity.position = new Vec3(12.5, 65, -5.5)
  bot.activateItem = () => { bot.sent.activate++; bot.cells['12,66,-7'] = cell('water', { level: 3 }, []) }
  await assert.rejects(() => useHeldItem(bot, { kind: 'use', goal: { item: 'bucket', count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'point', dimension: 'overworld' } } }, deps()), /bucket was not filled/)
})

test('a point use is judged by reach from the eyes, where the server raycasts from', async () => {
  const bot = scene({}, [{ name: 'water_bucket', count: 1 }])
  bot.entity.position = new Vec3(12.5, 66.5, -10.8)   // 4.4 from the feet, 5.0 from the eyes
  await assert.rejects(() => useHeldItem(bot, { kind: 'use', goal: { item: 'water_bucket', count: 1, expect: '', target: { x: 12, y: 65, z: -7, how: 'point', dimension: 'overworld' } } }, deps()), /Cannot reach/)
  assert.equal(bot.sent.activate, 0)
})


function protectedPortal(axis='x'){
 const cells={},pos=(u,y)=>axis==='x'?`${12+u},${65+y},-7`:`12,${65+y},${-7+u}`
 for(let u=0;u<2;u++){cells[pos(u,-1)]=cell('obsidian');cells[pos(u,3)]=cell('obsidian')}
 for(let y=0;y<3;y++){cells[pos(-1,y)]=cell('obsidian');cells[pos(2,y)]=cell('obsidian')}
 const bot=scene(cells)
 bot._genericPlace=async()=>{bot.sent.place++;for(let u=0;u<2;u++)for(let y=0;y<3;y++)cells[pos(u,y)]=cell('nether_portal',{},[])}
 const task=useTask({expect:'nether_portal',protectedSites:[{minX:0,maxX:20,minZ:-20,maxZ:0}]})
 return {bot,task,cells,pos}
}
test('a protected complete standard portal can be ignited in either orientation',async()=>{
 for(const axis of ['x','z']){
  const {bot,task}=protectedPortal(axis)
  const result=await useHeldItem(bot,task,deps())
  assert.equal(result.receipt,'use_effect_observed')
  assert.equal(bot.sent.place,1)
 }
})
test('protected portal exception rejects missing frame, obstructed interior and wrong expectation',async()=>{
 for(const change of ['frame','interior','expect']){
  const {bot,task,cells,pos}=protectedPortal()
  if(change==='frame')delete cells[pos(1,3)]
  if(change==='interior')cells[pos(1,1)]=cell('oak_planks')
  if(change==='expect')task.goal.expect='fire'
  await assert.rejects(()=>useHeldItem(bot,task,deps()),/saved project/)
  assert.equal(bot.sent.place,0)
 }
})
test('protected frame is rechecked after approach before ignition',async()=>{
 const {bot,task,cells,pos}=protectedPortal()
 let approached=false
 await assert.rejects(()=>useHeldItem(bot,task,{...deps(),approach:async()=>{approached=true;delete cells[pos(1,3)];return defaultApproach()}}),/saved project|frame/)
 assert.equal(approached,true)
 assert.equal(bot.sent.place,0)
})
