import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { readFileSync } from 'node:fs'
import {
  blocksNear, columnAbove, entitiesNear, worldObservation,
  DEFAULT_WORLD_BLOCKS, blockNamesFromGoal, applyInspectBlockRequest,
} from '../src/observations.js'
import { validatePlan } from '../src/companion/planner.js'

const AIR = { name: 'air', boundingBox: 'empty' }
const solid = (name = 'stone') => ({ name, boundingBox: 'block' })

function stubBot({ at = new Vec3(0.5, 64, 0.5), cells = {}, entities = {}, registry, unloaded = new Set() } = {}) {
  const names = registry || {
    stone: { id: 1 }, dirt: { id: 2 }, coal_ore: { id: 3 }, iron_ore: { id: 4 },
    deepslate_iron_ore: { id: 5 }, gravel: { id: 6 }, oak_log: { id: 7 },
    air: { id: 0 },
  }
  const cell = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (unloaded.has(k) || unloaded.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)) return null
    return cells[k] ?? AIR
  }
  const bot = {
    entity: { position: at.clone(), id: 1, name: 'player', type: 'player', velocity: new Vec3(0, 0, 0) },
    entities: { 1: null, ...entities },
    registry: { blocksByName: names },
    blockAt(p) { return cell(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    findBlocks({ matching, maxDistance, count }) {
      const origin = at.floored()
      const hits = []
      const r = maxDistance ?? 8
      for (let x = origin.x - r; x <= origin.x + r; x++)
        for (let y = origin.y - r; y <= origin.y + r; y++)
          for (let z = origin.z - r; z <= origin.z + r; z++) {
            const b = cell(x, y, z)
            if (!b) continue
            const id = names[b.name]?.id
            const ok = typeof matching === 'function' ? matching(b) : matching === id
            if (ok) hits.push(new Vec3(x, y, z))
            if (hits.length >= (count ?? 64)) return hits
          }
      return hits
    },
  }
  bot.entities[1] = bot.entity
  return bot
}

test('blocksNear finds named blocks sorted by distance and honours limit', () => {
  const bot = stubBot({
    cells: {
      '3,64,0': solid('stone'),
      '1,64,0': solid('dirt'),
      '5,64,0': solid('stone'),
      '0,64,2': solid('coal_ore'),
    },
  })
  const o = blocksNear(bot, { names: ['stone', 'dirt', 'coal_ore'], radius: 8, limit: 2 })
  assert.equal(o.blocks.length, 2)
  assert.equal(o.truncated, true)
  assert.deepEqual(o.blocks.map(b => b.name), ['dirt', 'coal_ore'])
  assert.ok(o.blocks[0].d <= o.blocks[1].d)
  assert.equal(o.scanned.radius, 8)
  assert.equal(o.scanned.loaded, true)
  assert.ok(Number.isInteger(o.blocks[0].x) && Number.isInteger(o.blocks[0].d))
})

test('blocksNear supports *_ore wildcard and any_solid', () => {
  const bot = stubBot({
    cells: {
      '2,64,0': solid('coal_ore'),
      '0,64,3': solid('deepslate_iron_ore'),
      '0,65,1': solid('dirt'),
      '1,64,1': AIR,
    },
  })
  const ores = blocksNear(bot, { names: ['*_ore'], radius: 8, limit: 24 })
  assert.deepEqual(ores.blocks.map(b => b.name).sort(), ['coal_ore', 'deepslate_iron_ore'])
  const solids = blocksNear(bot, { names: ['any_solid'], radius: 8, limit: 24 })
  assert.ok(solids.blocks.every(b => b.name !== 'air'))
  assert.ok(solids.blocks.some(b => b.name === 'dirt'))
})

test('blocksNear gives every requested name a fair share, so common stone cannot crowd out the one crafting table', () => {
  // A 5x5x5 shell of stone (well over the cap) with a single crafting table
  // at distance 7. Pure nearest-first would return 24 stone and no table.
  const cells = {}
  for (let x = -2; x <= 2; x++) for (let y = 62; y <= 66; y++) for (let z = -2; z <= 2; z++) {
    if (Math.abs(x) === 2 || Math.abs(z) === 2 || y === 62 || y === 66) cells[`${x},${y},${z}`] = solid('stone')
  }
  cells['7,64,0'] = solid('crafting_table')
  const bot = stubBot({ cells, registry: { stone: { id: 1 }, crafting_table: { id: 2 }, air: { id: 0 } } })
  const o = blocksNear(bot, { names: ['stone', 'crafting_table'], radius: 8, limit: 24 })
  assert.equal(o.blocks.length, 24)
  assert.ok(o.blocks.some(b => b.name === 'crafting_table' && b.x === 7), 'the table must be reported')
  assert.equal(o.blocks[0].name, 'stone', 'the nearest block still leads')
  assert.equal(o.truncated, true)
  // A name with no hits costs nothing and does not displace others.
  const p = blocksNear(bot, { names: ['stone', 'crafting_table', 'diamond_ore'], radius: 8, limit: 24 })
  assert.equal(p.blocks.length, 24)
  assert.ok(p.blocks.some(b => b.name === 'crafting_table'))
})

test('entitiesNear reports animals, passive, water and ambient creatures as mobs', () => {
  const at = (x) => new Vec3(x, 64, 0)
  const bot = stubBot({ entities: {
    2: { id: 2, name: 'cow', type: 'animal', position: at(2) },
    3: { id: 3, name: 'villager', type: 'passive', position: at(3) },
    4: { id: 4, name: 'cod', type: 'water_creature', position: at(4) },
    5: { id: 5, name: 'bat', type: 'ambient', position: at(5) },
    6: { id: 6, name: 'oak_boat', type: 'other', position: at(6) },
  } })
  const kinds = Object.fromEntries(entitiesNear(bot, { radius: 24 }).entities.map(e => [e.type, e.kind]))
  assert.deepEqual(kinds, { cow: 'mob', villager: 'mob', cod: 'mob', bat: 'mob', oak_boat: 'other' })
})

// Every planning round scans the ~25 default names; one findBlocks walk per
// name re-read every palette section that held any of them, synchronously.
test('blocksNear walks the world once per call, however many names it is asked for', () => {
  const bot = stubBot({ cells: { '3,64,0': solid('stone'), '1,64,0': solid('dirt'), '0,64,2': solid('coal_ore') } })
  const scan = bot.findBlocks.bind(bot)
  let calls = 0
  bot.findBlocks = options => { calls++; return scan(options) }
  const o = blocksNear(bot, { names: ['stone', 'dirt', 'coal_ore', 'lava', 'iron_ore'], radius: 8, limit: 24 })
  assert.equal(calls, 1)
  assert.deepEqual(o.blocks.map(b => b.name), ['dirt', 'coal_ore', 'stone'])
})

test('blocksNear reports loaded:false for an unloaded chunk without claiming air', () => {
  const bot = stubBot({
    cells: { '1,64,0': solid('stone') },
    unloaded: new Set(['2,64,0']),
  })
  // An unloaded area is a whole chunk column, never one cell: everything at
  // x >= 2 is unloaded here. The scan probes the cube's corners and centre on
  // each axis, which reaches every 16-aligned chunk column inside radius <= 16.
  bot.blockAt = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    if (x >= 2) return null
    if (x === 1 && y === 64 && z === 0) return solid('stone')
    return AIR
  }
  const o = blocksNear(bot, { names: ['stone'], radius: 8, limit: 24 })
  assert.equal(o.scanned.loaded, false)
  assert.ok(!o.blocks.some(b => b.name === 'air' && b.x === 2 && b.z === 0),
    'unloaded cells must not be reported as air')
  assert.ok(o.blocks.some(b => b.name === 'stone'))
})

test('columnAbove reports 12 solid cells then sky under a stone roof', () => {
  const cells = {}
  // Feet at y=64, head at y=65; twelve stone cells 65..76, air from 77 up.
  for (let y = 0; y < 65; y++) cells[`0,${y},0`] = solid('stone')
  for (let y = 65; y < 77; y++) cells[`0,${y},0`] = solid('stone')
  for (let y = 77; y < 120; y++) cells[`0,${y},0`] = { name: 'air', boundingBox: 'empty', skyLight: 15 }
  const bot = stubBot({ at: new Vec3(0.5, 64, 0.5), cells })
  bot.blockAt = (p) => {
    const b = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
    return b || { name: 'air', boundingBox: 'empty', skyLight: 15 }
  }
  const c = columnAbove(bot)
  assert.equal(c.solidCells, 12)
  assert.equal(c.firstSolid?.name, 'stone')
  assert.equal(c.surfaceAt, 77)
  assert.equal(c.skyVisible, false)
})

test('columnAbove reports skyVisible with zero solids in the open', () => {
  const bot = stubBot({
    at: new Vec3(0.5, 64, 0.5),
    cells: {},
  })
  bot.blockAt = (p) => ({ name: 'air', boundingBox: 'empty', skyLight: 15 })
  const c = columnAbove(bot)
  assert.equal(c.solidCells, 0)
  assert.equal(c.firstSolid, null)
  assert.equal(c.skyVisible, true)
  assert.ok(Number.isInteger(c.surfaceAt))
})

test('columnAbove returns null surfaceAt after 32 solid cells', () => {
  const bot = stubBot({ at: new Vec3(0.5, 64, 0.5) })
  bot.blockAt = () => solid('stone')
  const c = columnAbove(bot)
  assert.equal(c.solidCells, 32)
  assert.equal(c.surfaceAt, null)
  assert.equal(c.skyVisible, false)
  assert.equal(c.firstSolid?.name, 'stone')
})

test('entitiesNear excludes the bot, classifies kinds, and honours limit', () => {
  const bot = stubBot({
    entities: {
      2: { id: 2, name: 'zombie', type: 'mob', position: new Vec3(3.2, 64.1, 0.4), velocity: new Vec3(0.123, 0, -0.456) },
      3: { id: 3, name: 'item', type: 'object', position: new Vec3(1, 64, 1), velocity: null,
        getDroppedItem: () => ({ name: 'cobblestone', count: 3 }) },
      4: { id: 4, name: 'Steve', type: 'player', position: new Vec3(5, 64, 0), velocity: new Vec3(0, 0, 0) },
      5: { id: 5, name: 'cow', type: 'mob', position: new Vec3(20, 64, 0), velocity: new Vec3(0, 0, 0) },
      6: { id: 6, name: 'arrow', type: 'projectile', position: new Vec3(2, 65, 2), velocity: new Vec3(1, 0, 0) },
    },
  })
  const o = entitiesNear(bot, { radius: 24, limit: 3 })
  assert.ok(!o.entities.some(e => e.type === 'player' && e.x === 0 && e.d === 0 && e === bot.entity))
  assert.ok(!o.entities.some(e => e.d === 0 && e.type === bot.entity.name && Math.hypot(e.x - 0, e.z - 0) < 1 && e.kind === 'player' && e === undefined))
  assert.ok(o.entities.every(e => !(e.x === 0 && e.y === 64 && e.z === 0 && e.type === 'player' && e.d === 0)),
    'bot itself excluded')
  // Bot at 0.5,64,0.5 — none of the stubs are the bot entity reference.
  assert.equal(o.entities.length, 3)
  assert.equal(o.truncated, true)
  const full = entitiesNear(bot, { radius: 24, limit: 32 })
  const zombie = full.entities.find(e => e.type === 'zombie')
  assert.equal(zombie.kind, 'mob')
  assert.equal(zombie.velocity.x, 0.12)
  assert.equal(zombie.angry, null)
  const item = full.entities.find(e => e.kind === 'item')
  assert.equal(item.item, 'cobblestone')
  assert.equal(full.entities.find(e => e.type === 'Steve').kind, 'player')
  assert.equal(full.entities.find(e => e.type === 'arrow').kind, 'other')
  assert.ok(full.entities.every(e => Number.isInteger(e.x) && Number.isInteger(e.d)))
})

test('worldObservation carries blocks, column and entities under a size budget', () => {
  const cells = { '2,64,0': solid('stone'), '0,64,3': solid('coal_ore'), '1,64,1': solid('oak_log') }
  const bot = stubBot({
    cells,
    entities: {
      2: { id: 2, name: 'cow', type: 'mob', position: new Vec3(4, 64, 0), velocity: new Vec3(0, 0, 0) },
    },
    registry: Object.fromEntries([
      ...DEFAULT_WORLD_BLOCKS.filter(n => !n.includes('*')).map((n, i) => [n, { id: i + 1 }]),
      ['oak_log', { id: 100 }], ['oak_leaves', { id: 101 }],
    ]),
  })
  bot.blockAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    if (cells[k]) return cells[k]
    if (Math.floor(p.y) < 64) return solid('stone')
    return { name: 'air', boundingBox: 'empty', skyLight: 15 }
  }
  const world = worldObservation(bot, {
    goal: { criteria: [{ kind: 'block_at', item: 'obsidian', target: '', count: 1 }] },
    requestedBlocks: ['netherrack'],
  })
  assert.ok(world.blocks.blocks)
  assert.ok(world.column)
  assert.ok(world.entities.entities)
  assert.ok('truncated' in world.blocks && 'scanned' in world.blocks)
  const bytes = Buffer.byteLength(JSON.stringify(world), 'utf8')
  assert.ok(bytes < 2500, `world JSON must stay under ~2.5KB, got ${bytes}`)
  // Expose measured size for the harness report.
  worldObservation._lastBytes = bytes
})

test('inspect may carry a comma-separated block list and applyInspectBlockRequest stores it', () => {
  const plan = validatePlan({
    reply: 'Scanning for portal frame.',
    steps: [{ action: 'inspect', name: '', count: 0, item: 'obsidian,end_portal_frame', design: [] }],
  })
  assert.equal(plan.steps[0].item, 'obsidian,end_portal_frame')
  assert.throws(
    () => validatePlan({ reply: 'x', steps: [{ action: 'inspect', name: '', count: 0, item: 'Stone!!', design: [] }] }),
    /inspect|block/i,
  )
  const request = {}
  applyInspectBlockRequest(request, 'obsidian,lava')
  assert.deepEqual(request.requestedBlocks, ['obsidian', 'lava'])
  const bot = stubBot({
    cells: { '1,64,0': solid('obsidian') },
    registry: { stone: { id: 1 }, obsidian: { id: 9 }, lava: { id: 10 } },
  })
  bot.blockAt = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    if (x === 1 && y === 64 && z === 0) return solid('obsidian')
    if (y < 64) return solid('stone')
    return { name: 'air', boundingBox: 'empty', skyLight: 15 }
  }
  const world = worldObservation(bot, { requestedBlocks: request.requestedBlocks, radius: 16 })
  assert.ok(world.blocks.blocks.some(b => b.name === 'obsidian'))
  assert.equal(world.blocks.scanned.radius, 16)
})

test('blockNamesFromGoal pulls block_at and inventory block ids', () => {
  // iron_pickaxe is an item with no block form, so it is absent from blocksByName.
  const registry = { blocksByName: { obsidian: { id: 1 }, crafting_table: { id: 2 } } }
  const names = blockNamesFromGoal({
    criteria: [
      { kind: 'block_at', item: 'obsidian', target: '', count: 1 },
      { kind: 'inventory', item: 'crafting_table', count: 1 },
      { kind: 'inventory', item: 'iron_pickaxe', count: 1 },
      { kind: 'tools', item: 'crafting_table', count: 1 },
    ],
  }, registry)
  assert.ok(names.includes('obsidian'))
  assert.ok(names.includes('crafting_table'))
  assert.ok(!names.includes('iron_pickaxe'))
})

test('the teammate brief teaches inspect block lists and where the answer lands', () => {
  // A channel the brief never mentions is one the planner never asks for.
  const brief = readFileSync(new URL('../src/companion/teammate-prompt.txt', import.meta.url), 'utf8')
  const line = brief.split('\n').find(l => l.startsWith('inspect:'))
  assert.match(line, /comma-separated block IDs/)
  assert.match(line, /observation\.world/)
  assert.match(brief, /world\.column/, 'the column over its head is named, so a buried agent can find the surface')
})
