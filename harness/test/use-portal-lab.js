// Phase E, exercise 2: ignition, the declared expectation, and the falsifiers.
//
// This is the first exercise that can start a fire, which is why bone meal went
// first. Three parts:
//   A. a good frame  -> use_effect_observed, the declared-expectation path
//   B. block_at live -> still passes 40 blocks away; fails when a frame is broken
//   C. a bad frame   -> expectation failure naming what it observed, fire dug out
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import mineflayer from 'mineflayer'
import pathfinder from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { useHeldItem } from '../src/use-item.js'
import { approachPlacement } from '../src/world-skills.js'
import { validateContract, evaluateGoal } from '../src/companion/goal-contract.js'

// Target is env-driven so the same exercise runs against the disposable local
// vanilla lab and the persistent Paper server on Proxmox. Paper is a different
// implementation, so a pass on one is not a pass on the other.
const HOST = process.env.MC_LAB_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_LAB_PORT || 25567)
const NAME = process.env.MC_LAB_NAME || 'SoulStoneLab'
const VERSION = process.env.MC_LAB_VERSION || '26.2'
import { createHash } from 'node:crypto'
const _d = Buffer.from(createHash('md5').update(`OfflinePlayer:${NAME}`).digest())
_d[6] = (_d[6] & 0x0f) | 0x30; _d[8] = (_d[8] & 0x3f) | 0x80
const _h = _d.toString('hex')
const UUID = `${_h.slice(0,8)}-${_h.slice(8,12)}-${_h.slice(12,16)}-${_h.slice(16,20)}-${_h.slice(20,32)}`


// The launcher's own Java 25, which a 26.2 server requires. Kept out of the
// repo as an absolute path: override with MC_JAVA when it lives elsewhere.
const JAVA = process.env.MC_JAVA || join(homedir(),'Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java')
const assets = fileURLToPath(new URL('../bridge/', import.meta.url))
const { Movements } = pathfinder
const log = (...a) => console.log(...a)

async function startBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'soulstone-lab-bridge-'))
  mkdirSync(join(dir, 'plugins'), { mode: 0o700 })
  copyFileSync(join(assets, 'SoulStoneBridge-3.4.12.jar'), join(dir, 'plugins/SoulStoneBridge.jar'))
  const child = spawn(JAVA, ['-Xmx512m', '-Djava.awt.headless=true', '-jar', join(assets, 'SoulStoneBridge-3.4.12.jar'),
    'cli', '--bind-address', '127.0.0.1:0', '--target-address', `${HOST}:${PORT}`, '--target-version', '26.2',
    '--proxy-online-mode', 'false', '--auth-method', 'NONE', '--log-ips', 'false',
    '--simple-voice-chat-support', 'false', '--rewrite-transfer-packets', 'false'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stdin.write(JSON.stringify({ uuid: UUID, clientProtocol: 769, serverProtocol: 776 }) + '\n')
  let err = ''; child.stderr.on('data', d => { err += d })
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('bridge not ready:\n' + err.slice(-1200))), 40000)
    child.once('exit', c => { clearTimeout(t); rej(new Error(`bridge exited ${c}`)) })
    createInterface({ input: child.stdout }).on('line', l => {
      const i = l.indexOf('SOULSTONE_BRIDGE '); if (i < 0) return
      try { const v = JSON.parse(l.slice(i + 17)); if (v.type === 'ready') { clearTimeout(t); res(v.port) } } catch {}
    })
  })
  return { child, port }
}

const deps = bot => ({
  check() {}, stage() {}, persist() {},
  walk: async g => { await bot.pathfinder.goto(g) },
  approach: approachPlacement,
  async settle(predicate, message) {
    let stable = 0
    for (let i = 0; i < 60; i++) { if (predicate()) stable++; else stable = 0; if (stable >= 5) return; await delay(100) }
    throw new Error(message)
  },
})

async function buildFrame(bot, o, { complete = true } = {}) {
  const set = (x, y, z, b) => bot.chat(`/setblock ${x} ${y} ${z} minecraft:${b}`)
  // clear the volume so nothing pre-existing confuses the read
  bot.chat(`/fill ${o.x - 1} ${o.y} ${o.z - 1} ${o.x + 4} ${o.y + 6} ${o.z + 1} minecraft:air`)
  await delay(500)
  bot.chat(`/fill ${o.x - 1} ${o.y - 1} ${o.z - 1} ${o.x + 4} ${o.y - 1} ${o.z + 1} minecraft:stone`)
  await delay(400)
  for (const x of [o.x + 1, o.x + 2]) { set(x, o.y, o.z, 'obsidian'); set(x, o.y + 4, o.z, 'obsidian') }
  for (let y = o.y + 1; y <= o.y + 3; y++) {
    set(o.x, y, o.z, 'obsidian')
    // Leaving one side block out makes the frame invalid: the game produces fire
    // instead of a portal, which is the diagnosis path under test in part C.
    if (complete || y !== o.y + 2) set(o.x + 3, y, o.z, 'obsidian')
  }
  await delay(1200)
}

async function main() {
  const bridge = await startBridge()
  log(`bridge ready on 127.0.0.1:${bridge.port}`)
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: bridge.port, username: NAME, auth: 'offline', version: '1.21.4' })
  bot.loadPlugin(pathfinder.pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', r => rej(new Error('kicked: ' + r))) })
  bot.pathfinder.setMovements(new Movements(bot))
  log(`joined; dimension ${bot.game.dimension}`)
  bot.chat(`/give ${NAME} minecraft:flint_and_steel 4`)
  bot.chat(`/time set day`)
  await delay(1200)

  const p = bot.entity.position.floored()
  const results = {}

  // ---- A. a good frame ----
  const o = new Vec3(p.x + 4, p.y, p.z + 4)
  await buildFrame(bot, o, { complete: true })
  const inner = new Vec3(o.x + 1, o.y + 1, o.z)
  log(`\n--- A: frame at ${o}, lighting interior ${inner} ---`)
  log(`interior before: ${bot.blockAt(inner)?.name}`)
  const taskA = { kind: 'use', goal: { item: 'flint_and_steel', count: 1, expect: 'nether_portal',
    target: { x: inner.x, y: inner.y, z: inner.z, how: 'click', dimension: 'overworld' } } }
  let rA, eA
  try { rA = await useHeldItem(bot, taskA, deps(bot)) } catch (e) { eA = e }
  log(eA ? `THREW: ${eA.message}` : `receipt: ${rA.receipt} | observed: ${rA.observed.name} ${JSON.stringify(rA.observed.state)} | spent durability ${rA.spent.durabilityBefore}->${rA.spent.durabilityAfter}`)
  results.A = eA ? `THREW ${eA.message.slice(0, 80)}` : rA.receipt
  log(`interior now: ${bot.blockAt(inner)?.name}`)

  // ---- B. block_at, live, with the falsifiers ----
  if (rA?.receipt === 'use_effect_observed') {
    const contract = validateContract({
      kind: 'task', summary: 'Light a nether portal.', projectMode: 'none', milestones: ['Light it'], constraints: [],
      milestonePlan: [{ id: 'light', description: 'Light the portal and confirm it.', dependsOn: [], criteria: [0] }],
      criteria: [{ kind: 'block_at', description: 'A nether portal exists that this request lit.', target: '', item: 'nether_portal', count: 1 }],
    }, {})
    const fb = [{ action: 'use', status: 'completed', result: rA }]
    const snap = () => ({ position: bot.entity.position })
    const v1 = evaluateGoal(contract, snap(), bot, fb)
    log(`\n--- B: block_at ---`)
    log(`standing at the portal: ${v1.verdict} ${JSON.stringify(v1.checks[0].observed)}`)
    // falsifier 1: walking away must NOT un-complete it
    await bot.pathfinder.goto(new pathfinder.goals.GoalNear(p.x - 40, p.y, p.z, 2)).catch(() => {})
    await delay(1500)
    const v2 = evaluateGoal(contract, snap(), bot, fb)
    log(`40 blocks away:        ${v2.verdict} ${JSON.stringify(v2.checks[0].observed)}`)
    // falsifier 2: breaking a frame block must fail it
    bot.chat(`/setblock ${inner.x} ${inner.y} ${inner.z} minecraft:air`)
    await delay(1500)
    const v3 = evaluateGoal(contract, snap(), bot, fb)
    log(`after breaking it:     ${v3.verdict} ${JSON.stringify(v3.checks[0].observed)}`)
    results.B = { atPortal: v1.verdict, awayFrom: v2.verdict, broken: v3.verdict }
    await bot.pathfinder.goto(new pathfinder.goals.GoalNear(p.x, p.y, p.z, 2)).catch(() => {})
  }

  // ---- C. a malformed frame: expectation failure, and the fire dug out ----
  const o2 = new Vec3(p.x + 4, p.y, p.z - 6)
  await buildFrame(bot, o2, { complete: false })
  const inner2 = new Vec3(o2.x + 1, o2.y + 1, o2.z)
  log(`\n--- C: deliberately incomplete frame at ${o2} ---`)
  const taskC = { kind: 'use', goal: { item: 'flint_and_steel', count: 1, expect: 'nether_portal',
    target: { x: inner2.x, y: inner2.y, z: inner2.z, how: 'click', dimension: 'overworld' } } }
  let rC, eC
  try { rC = await useHeldItem(bot, taskC, deps(bot)) } catch (e) { eC = e }
  log(eC ? `THREW: ${eC.message}` : `unexpectedly succeeded: ${rC.receipt}`)
  await delay(1200)
  log(`cell after the failure: ${bot.blockAt(inner2)?.name}`)
  results.C = { threw: !!eC, message: eC?.message?.slice(0, 160) ?? null, cellAfter: bot.blockAt(inner2)?.name }

  log('\n===== SUMMARY =====')
  log(JSON.stringify(results, null, 1))
  const pass = results.A === 'use_effect_observed'
    && results.B?.atPortal === 'passed' && results.B?.awayFrom === 'passed' && results.B?.broken === 'needs_work'
    && results.C?.threw && /observed/.test(results.C.message || '')
  log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}`)
  bot.quit(); bridge.child.kill('SIGTERM')
  await delay(800)
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error('LAB ERROR:', e.message); process.exit(2) })
