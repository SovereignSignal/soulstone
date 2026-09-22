// Phase E, exercise 1: bone meal on a sapling, through the 26.2 bridge.
//
// Not run by `npm test`. This is the first time `use` touches a server, and it
// is deliberately the cheapest possible one: bone meal is probabilistic, so a
// spend with no visible growth is a legitimate pass, and nothing burns.
//
// What it proves that no unit test can: that _genericPlace writes a packet
// ViaProxy actually translates from 1.21.4 (769) to 26.2 (776), that settle()
// sees real server state, and that the spend channel moves. The old direct
// 1.21.4 lab could not prove any of it, because it had no bridge in the path.
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
const { goals, Movements } = pathfinder

async function startBridge() {
  // The adapter is a ViaProxy PLUGIN: ViaProxy loads ./plugins relative to cwd,
  // so it has to run from a directory that contains it. Running from the bridge
  // dir loads no plugin, emits nothing, and looks like a hang.
  const dir = mkdtempSync(join(tmpdir(), 'soulstone-lab-bridge-'))
  mkdirSync(join(dir, 'plugins'), { mode: 0o700 })
  copyFileSync(join(assets, 'SoulStoneBridge-3.4.12.jar'), join(dir, 'plugins/SoulStoneBridge.jar'))
  const child = spawn(JAVA, ['-Xmx512m', '-Djava.awt.headless=true', '-jar', join(assets, 'SoulStoneBridge-3.4.12.jar'),
    'cli', '--bind-address', '127.0.0.1:0', '--target-address', `${HOST}:${PORT}`, '--target-version', VERSION,
    '--proxy-online-mode', 'false', '--auth-method', 'NONE', '--log-ips', 'false',
    '--simple-voice-chat-support', 'false', '--rewrite-transfer-packets', 'false'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stdin.write(JSON.stringify({ uuid: UUID, clientProtocol: 769, serverProtocol: 776 }) + '\n')
  let err = ''
  child.stderr.on('data', d => { err += d })
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge not ready in 40s. stderr:\n' + err.slice(-1500))), 40000)
    child.once('exit', c => { clearTimeout(t); reject(new Error(`bridge exited ${c}. stderr:\n` + err.slice(-1500))) })
    createInterface({ input: child.stdout }).on('line', l => {
      const i = l.indexOf('SOULSTONE_BRIDGE '); if (i < 0) return
      try { const v = JSON.parse(l.slice(i + 17)); if (v.type === 'ready') { clearTimeout(t); resolve(v.port) } } catch {}
    })
  })
  return { child, port }
}

const log = (...a) => console.log(...a)

async function main() {
  log('starting bridge 26.2(776) -> 1.21.4(769) ...')
  const bridge = await startBridge()
  log(`bridge ready on 127.0.0.1:${bridge.port}`)

  const bot = mineflayer.createBot({ host: '127.0.0.1', port: bridge.port, username: NAME, auth: 'offline', version: '1.21.4' })
  bot.loadPlugin(pathfinder.pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', r => rej(new Error('kicked: ' + r))) })
  log(`joined as ${bot.username}; server reports version ${bot.version}; dimension ${bot.game.dimension}`)
  bot.pathfinder.setMovements(new Movements(bot))

  // Fixture. This is a disposable lab: granting the item and planting the
  // sapling is setup, not progression evidence.
  const p = bot.entity.position.floored()
  bot.chat(`/give ${NAME} minecraft:bone_meal 64`)
  const boneMeal = () => bot.inventory.items().filter(i => i.name === 'bone_meal').reduce((n, i) => n + i.count, 0)

  const deps = {
    check() {}, stage() {}, persist() {},
    walk: async g => { await bot.pathfinder.goto(g) },
    approach: approachPlacement,
    async settle(predicate, message) {
      let stable = 0
      for (let i = 0; i < 60; i++) { if (predicate()) stable++; else stable = 0; if (stable >= 5) return; await delay(100) }
      throw new Error(message)
    },
  }

  // Each attempt gets its OWN cell and its OWN task. Repeating on one cell is
  // exactly what the latch refuses, so sampling has to move.
  const results = []
  for (let i = 0; i < 6; i++) {
    const ground = new Vec3(p.x + 2 + i, p.y - 1, p.z)
    const cell = ground.offset(0, 1, 0)
    bot.chat(`/setblock ${ground.x} ${ground.y} ${ground.z} minecraft:dirt`)
    await delay(300)
    bot.chat(`/setblock ${cell.x} ${cell.y} ${cell.z} minecraft:oak_sapling`)
    await delay(900)
    if (bot.blockAt(cell)?.name !== 'oak_sapling') { log(`attempt ${i}: fixture did not take, skipping`); continue }
    const before = boneMeal()
    const task = { kind: 'use', goal: { item: 'bone_meal', count: 1, expect: '',
      target: { x: cell.x, y: cell.y, z: cell.z, how: 'click', dimension: 'overworld' } } }
    let r, failure
    try { r = await useHeldItem(bot, task, deps) } catch (e) { failure = e }
    const after = boneMeal()
    const line = { attempt: i, cell: `${cell.x},${cell.y},${cell.z}`, spent: before - after,
      receipt: failure ? `THREW: ${failure.message.slice(0, 70)}` : r.receipt,
      changed: failure ? null : r.changed.map(c => `${c.from}->${c.to}`), now: bot.blockAt(cell)?.name }
    results.push(line)
    log(`attempt ${i}: spent ${line.spent} | ${line.receipt} | changed ${JSON.stringify(line.changed)} | cell now ${line.now}`)
    await delay(500)
  }

  log('\n===== SUMMARY =====')
  const charged = results.filter(r => r.spent > 0).length
  const observed = results.filter(r => r.receipt === 'use_change_observed').length
  const unobserved = results.filter(r => r.receipt === 'use_effect_unobserved').length
  const threw = results.filter(r => String(r.receipt).startsWith('THREW')).length
  log(`attempts ${results.length} | charged ${charged} | use_change_observed ${observed} | use_effect_unobserved ${unobserved} | threw ${threw}`)
  log(`bone meal remaining: ${boneMeal()}`)
  const verdict = threw ? 'FAIL (a use threw)' : charged === 0 ? 'FAIL (no packet was ever accepted)'
    : observed > 0 ? 'PASS (both receipt paths seen live through the bridge)'
    : 'PASS (packets accepted and charged; growth never observed, which bone meal is allowed to do)'
  log(`\nVERDICT: ${verdict}`)

  bot.quit(); bridge.child.kill('SIGTERM')
  await delay(800)
  process.exit(verdict.startsWith('PASS') ? 0 : 1)
}
main().catch(e => { console.error('LAB ERROR:', e.message); process.exit(2) })
