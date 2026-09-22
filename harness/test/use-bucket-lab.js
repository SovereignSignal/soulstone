// Phase E, exercise 3: point mode, the one designed path never exercised live.
//
// Buckets are why `point` exists at all: BucketItem implements Item.use() and
// never useOn, so a click at a water cell does nothing. The two directions are
// deliberately judged differently. Filling is proven by the transmutation alone,
// because an infinite source still reads `water` afterwards. Emptying needs the
// scene diff too, because a pour that landed anywhere transmutes identically.
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
import { useHeldItem, interactableObservation } from '../src/use-item.js'
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
const log = (...a) => console.log(...a)

async function startBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'b-')); mkdirSync(join(dir, 'plugins'), { mode: 0o700 })
  copyFileSync(join(assets, 'SoulStoneBridge-3.4.12.jar'), join(dir, 'plugins/SoulStoneBridge.jar'))
  const child = spawn(JAVA, ['-Xmx512m', '-Djava.awt.headless=true', '-jar', join(assets, 'SoulStoneBridge-3.4.12.jar'),
    'cli', '--bind-address', '127.0.0.1:0', '--target-address', '127.0.0.1:25567', '--target-version', '26.2',
    '--proxy-online-mode', 'false', '--auth-method', 'NONE', '--log-ips', 'false',
    '--simple-voice-chat-support', 'false', '--rewrite-transfer-packets', 'false'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {}); child.stdin.write(JSON.stringify({ uuid: UUID, clientProtocol: 769, serverProtocol: 776 }) + '\n')
  child.stderr.on('data', () => {})
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('bridge')), 40000)
    createInterface({ input: child.stdout }).on('line', l => {
      const i = l.indexOf('SOULSTONE_BRIDGE '); if (i < 0) return
      try { const v = JSON.parse(l.slice(i + 17)); if (v.type === 'ready') { clearTimeout(t); res(v.port) } } catch {}
    })
  })
  return { child, port }
}

const main = async () => {
  const bridge = await startBridge()
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: bridge.port, username: NAME, auth: 'offline', version: '1.21.4' })
  bot.loadPlugin(pathfinder.pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('kicked', r => rej(new Error('kicked: ' + r))) })
  bot.pathfinder.setMovements(new pathfinder.Movements(bot))
  const deps = { check() {}, stage() {}, persist() {}, walk: async g => { await bot.pathfinder.goto(g) }, approach: approachPlacement,
    async settle(pred, msg) { let s = 0; for (let i = 0; i < 60; i++) { if (pred()) s++; else s = 0; if (s >= 5) return; await delay(100) } throw new Error(msg) } }
  const carry = n => bot.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0)

  const p = bot.entity.position.floored()
  const basin = new Vec3(p.x + 3, p.y, p.z - 3)
  bot.chat('/clear'); await delay(500)
  bot.chat(`/give ${NAME} minecraft:bucket 1`)
  // An OPEN-TOPPED basin. The first attempt filled a solid 3x3x3 of stone and
  // set the centre to water, which encloses the source completely: point mode
  // makes the SERVER raycast, and it hit the stone shell every time.
  bot.chat(`/fill ${basin.x - 1} ${basin.y - 1} ${basin.z - 1} ${basin.x + 1} ${basin.y + 1} ${basin.z + 1} minecraft:stone`)
  await delay(700)
  bot.chat(`/fill ${basin.x - 1} ${basin.y + 1} ${basin.z - 1} ${basin.x + 1} ${basin.y + 1} ${basin.z + 1} minecraft:air`)
  bot.chat(`/setblock ${basin.x} ${basin.y} ${basin.z} minecraft:water`)
  await delay(1500)
  log(`basin ${basin}: ${bot.blockAt(basin)?.name} ${JSON.stringify(bot.blockAt(basin)?.getProperties?.() ?? {})}`)

  const results = {}
  // The channel that tells the planner where a fillable cell is at all.
  const obs = interactableObservation(bot, { names: ['obsidian'] })
  log(`interactables nearestSource: ${JSON.stringify(obs.nearestSource)}`)
  results.nearestSource = obs.nearestSource.water ?? null

  // ---- fill: proven by the transmutation alone ----
  log(`\n--- fill: bucket=${carry('bucket')} water_bucket=${carry('water_bucket')} ---`)
  const fill = { kind: 'use', goal: { item: 'bucket', count: 1, expect: '',
    target: { x: basin.x, y: basin.y, z: basin.z, how: 'point', dimension: 'overworld' } } }
  let rF, eF
  try { rF = await useHeldItem(bot, fill, deps) } catch (e) { eF = e }
  log(eF ? `THREW: ${eF.message}` : `receipt: ${rF.receipt} | gained ${JSON.stringify(rF.gained)} | changed ${rF.changed.length}`)
  log(`after: bucket=${carry('bucket')} water_bucket=${carry('water_bucket')}`)
  results.fill = eF ? `THREW ${eF.message.slice(0, 90)}` : rF.receipt

  // ---- empty: needs the scene diff as well ----
  const pour = new Vec3(p.x + 3, p.y + 1, p.z + 3)
  bot.chat(`/fill ${pour.x - 1} ${pour.y - 1} ${pour.z - 1} ${pour.x + 1} ${pour.y - 1} ${pour.z + 1} minecraft:stone`)
  bot.chat(`/setblock ${pour.x} ${pour.y} ${pour.z} minecraft:air`)
  await delay(1200)
  log(`\n--- empty into ${pour} (${bot.blockAt(pour)?.name}) ---`)
  const empty = { kind: 'use', goal: { item: 'water_bucket', count: 1, expect: '',
    target: { x: pour.x, y: pour.y, z: pour.z, how: 'point', dimension: 'overworld' } } }
  let rE, eE
  try { rE = await useHeldItem(bot, empty, deps) } catch (e) { eE = e }
  log(eE ? `THREW: ${eE.message}` : `receipt: ${rE.receipt} | gained ${JSON.stringify(rE.gained)} | changed ${JSON.stringify(rE.changed.map(c => `${c.from}->${c.to}`))}`)
  log(`cell now: ${bot.blockAt(pour)?.name} | bucket=${carry('bucket')} water_bucket=${carry('water_bucket')}`)
  results.empty = eE ? `THREW ${eE.message.slice(0, 90)}` : rE.receipt

  // ---- a non-bucket in point mode must still be refused, live ----
  bot.chat(`/give ${NAME} minecraft:ender_eye 1`); await delay(1000)
  const eye = { kind: 'use', goal: { item: 'ender_eye', count: 1, expect: '',
    target: { x: basin.x, y: basin.y, z: basin.z, how: 'point', dimension: 'overworld' } } }
  let eG
  try { await useHeldItem(bot, eye, deps) } catch (e) { eG = e }
  log(`\n--- ender_eye in point mode: ${eG ? eG.message.slice(0, 80) : 'NOT REFUSED'} ---`)
  results.eyeRefused = !!eG && /not a block interaction/.test(eG.message)

  // ---- the SOLID branch: raycast for the face actually hit ----
  // The portal used the air branch and bone meal the shapeless one. This is the
  // third, and it is the End's mechanism: end_portal_frame keeps its name and
  // only `eye` flips, so a name-only diff and placeBlock's type comparison are
  // both blind to it.
  const frame = new Vec3(p.x - 3, p.y, p.z + 3)
  bot.chat(`/fill ${frame.x - 1} ${frame.y - 1} ${frame.z - 1} ${frame.x + 1} ${frame.y - 1} ${frame.z + 1} minecraft:stone`)
  bot.chat(`/setblock ${frame.x} ${frame.y} ${frame.z} minecraft:end_portal_frame[eye=false,facing=north]`)
  bot.chat(`/give ${NAME} minecraft:ender_eye 1`)
  await delay(1500)
  const b0 = bot.blockAt(frame)
  log(`\n--- solid branch: ${frame} is ${b0?.name} ${JSON.stringify(b0?.getProperties?.() ?? {})} ---`)
  const insert = { kind: 'use', goal: { item: 'ender_eye', count: 1, expect: 'end_portal_frame[eye=true]',
    target: { x: frame.x, y: frame.y, z: frame.z, how: 'click', dimension: 'overworld' } } }
  let rI, eI
  try { rI = await useHeldItem(bot, insert, deps) } catch (e) { eI = e }
  log(eI ? `THREW: ${eI.message}` : `receipt: ${rI.receipt} | observed ${rI.observed.name} ${JSON.stringify(rI.observed.state)} | gained ${JSON.stringify(rI.gained)}`)
  log(`frame now: ${JSON.stringify(bot.blockAt(frame)?.getProperties?.() ?? {})}`)
  results.eyeInsert = eI ? `THREW ${eI.message.slice(0, 90)}` : rI.receipt
  // Idempotence: a replan must not burn a second eye on a frame already filled.
  bot.chat(`/give ${NAME} minecraft:ender_eye 1`); await delay(1000)
  const again = { kind: 'use', goal: { ...insert.goal } }
  let rR
  try { rR = await useHeldItem(bot, again, deps) } catch (e) { rR = { receipt: `THREW ${e.message.slice(0, 60)}` } }
  log(`repeat on the filled frame: ${rR.receipt} (eyes carried ${carry('ender_eye')})`)
  results.eyeIdempotent = rR.receipt

  log('\n===== SUMMARY =====')
  log(JSON.stringify(results, null, 1))
  const pass = results.fill === 'use_change_observed' && results.empty === 'use_change_observed'
    && results.eyeRefused && results.nearestSource
    && results.eyeInsert === 'use_effect_observed' && results.eyeIdempotent === 'use_already_satisfied'
  log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}`)
  bot.quit(); bridge.child.kill('SIGTERM'); await delay(700); process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error('LAB ERROR:', e.message); process.exit(2) })
