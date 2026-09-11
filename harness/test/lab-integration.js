import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import { once } from 'node:events'

// Explicit opt-in: this suite edits the disposable server and kills/kicks its test bot.
if (process.env.MC_LAB_EXPERIMENT !== 'yes') throw new Error('Set MC_LAB_EXPERIMENT=yes to authorize fixture changes and bot failure injection')
const sshHost = process.env.MC_SSH_HOST
const testUsername = process.env.MC_TEST_USERNAME || 'HarnessRunner'
if (!/^[A-Za-z0-9_]{1,16}$/.test(testUsername)) throw new Error('invalid test username')
if (!sshHost || !/^[a-zA-Z0-9_.-]+$/.test(sshHost) || !process.env.MC_HOST) throw new Error('Set MC_SSH_HOST and MC_HOST')
const run = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
const started = Date.now()
const dir = resolve(`results/lab-${started}`)
mkdirSync(dir, { recursive: true })
const state = resolve(dir, 'task.json')
const report = { startedAt: new Date(started).toISOString(), fixture: 'platform-v1', version: '1.21.4',
  model: null, tokens: 0, tests: [], events: [], console: [] }
const start = { x: 2.5, y: 251, z: 8.5 }
const target = { x: 80.5, y: 251, z: 8.5 }
let child
let output = ''
let events = []
async function rcon(command) {
  command = command.replaceAll('HarnessRunner', testUsername)
  const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost,
    `sudo docker exec mc-sandbox rcon-cli ${quote(command)}`], { timeout: 15000 })
  report.console.push({ command, response: stdout.trim() })
  if (/Unknown or incomplete|Incorrect argument|No entity was found|not found|Unknown command/i.test(stdout)) throw new Error(`RCON failed: ${command}: ${stdout}`)
  return stdout.trim()
}
async function position() {
  const response = await rcon('data get entity HarnessRunner Pos')
  const match = response.match(/\[([-+\d.eE]+)d,\s*([-+\d.eE]+)d,\s*([-+\d.eE]+)d\]/)
  assert.ok(match, `Cannot parse server position: ${response}`)
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
function launch(chatControl = false) {
  events = []; output = ''
  child = spawn(process.execPath, ['src/cli.js'], { env: { ...process.env, MC_USERNAME: testUsername, MC_STATE: state,
    MC_CHAT_CONTROL: chatControl ? 'yes' : 'no', MC_OWNER: 'HarnessWitness' }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => {
    output += chunk
    let index
    while ((index = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, index); output = output.slice(index + 1)
      try { const e = JSON.parse(line); events.push(e); report.events.push(e) } catch { report.events.push({ type: 'stdout', line }) }
    }
  })
  child.stderr.on('data', data => report.events.push({ type: 'stderr', text: String(data) }))
}
function command(value) { child.stdin.write(JSON.stringify(value) + '\n') }
async function waitFor(predicate, from = 0, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const found = events.slice(from).find(predicate)
    if (found) return found
    if (child.exitCode !== null || child.signalCode) throw new Error('Runner exited before expected event')
    await pause(30)
  }
  throw new Error(`Event timeout; last events: ${JSON.stringify(events.slice(-3))}`)
}
async function shutdown(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return
  const current = child
  const exited = new Promise(resolve => current.once('exit', resolve))
  current.kill(signal)
  await Promise.race([exited, pause(5000).then(() => { if (current.exitCode === null && !current.signalCode) current.kill('SIGKILL') })])
  await pause(300)
}
async function reset() {
  command({ action: 'stop' })
  await pause(200)
  await rcon('clear HarnessRunner')
  await rcon('gamemode survival HarnessRunner')
  await rcon('effect give HarnessRunner minecraft:instant_health 1 10 true')
  await rcon('spawnpoint HarnessRunner 2 251 8')
  await rcon('tp HarnessRunner 2.5 251 8.5')
  await pause(500)
  assert.ok(distance(await position(), start) < 0.2, 'fixture reset did not reach fixed start')
}
async function begin(goal = target) {
  const mark = events.length
  command({ action: 'navigate', goal, timeoutMs: 60000 })
  const event = await waitFor(e => e.type === 'task_started', mark)
  return { mark, id: event.task.id }
}
async function completed(mark, id, goal = target) {
  const event = await waitFor(e => e.type === 'task_finished' && e.task?.id === id, mark, 65000)
  assert.equal(event.task.status, 'completed')
  const p = await position()
  assert.ok(distance(p, goal) <= 3, `server position outside goal radius: ${JSON.stringify(p)}`)
  return { position: p, distance: distance(p, goal), taskId: id }
}
async function test(name, fn) {
  const t = Date.now()
  console.log(`RUN ${name}`)
  try { const evidence = await fn(); report.tests.push({ name, status: 'passed', elapsedMs: Date.now() - t, evidence }); console.log(`PASS ${name}`) }
  catch (error) { report.tests.push({ name, status: 'failed', elapsedMs: Date.now() - t, reason: error.message }); throw error }
  finally { writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)) }
}

try {
  await rcon('whitelist add HarnessRunner')
  await rcon('difficulty peaceful')
  await rcon('gamerule doDaylightCycle false')
  await rcon('gamerule doWeatherCycle false')
  await rcon('gamerule doMobSpawning false')
  await rcon('gamerule spawnRadius 0')
  await rcon('time set noon')
  await rcon('weather clear')
  await rcon('forceload add 0 0 100 16')
  await rcon('fill 0 250 0 100 250 16 minecraft:smooth_stone')
  await rcon('fill 0 251 0 100 255 16 minecraft:air')
  await rcon('setworldspawn 2 251 8')

  if (process.env.MC_TEST_SCOPE !== 'skills') {
  await test('baseline: three repeatable joins', async () => {
    const positions = []
    for (let i = 0; i < 3; i++) {
      launch(); await waitFor(e => e.type === 'spawn'); await reset(); await pause(5000)
      positions.push(await position()); assert.equal(events.some(e => e.type === 'death'), false)
      await shutdown()
    }
    return { positions }
  })
  launch(); await waitFor(e => e.type === 'spawn'); await reset()
  await test('T2: navigate', async () => {
    const goal = { x: 22.5, y: 251, z: 8.5 }
    const { mark, id } = await begin(goal)
    return completed(mark, id, goal)
  })
  await reset()
  await test('T7: actual kick and resume', async () => {
    const { mark, id } = await begin(); await pause(1200)
    const before = await position(); assert.ok(distance(before, target) > 3)
    const response = await rcon('kick HarnessRunner harness-reconnect-test')
    await waitFor(e => e.type === 'kicked', mark)
    await waitFor(e => e.type === 'reconnecting', mark)
    const result = await completed(mark, id)
    return { before, kickResponse: response, ...result }
  })
  await reset()
  await test('durability: process killed and restarted', async () => {
    const { id } = await begin(); await pause(1200)
    assert.ok(distance(await position(), target) > 3)
    await shutdown('SIGKILL')
    assert.equal(JSON.parse(readFileSync(state)).task.status, 'running')
    launch(); await waitFor(e => e.type === 'spawn')
    return completed(0, id)
  })
  await reset()
  await test('stop: cancellation survives reconnect and restart', async () => {
    await begin(); await pause(1000)
    command({ action: 'stop' }); await pause(500)
    const stopped = await position(); await pause(1500)
    assert.ok(distance(await position(), stopped) < 0.1)
    const mark = events.length
    await rcon('kick HarnessRunner harness-stop-test')
    await waitFor(e => e.type === 'spawn', mark)
    assert.equal(events.slice(mark).some(e => e.type === 'navigating'), false)
    await shutdown('SIGKILL'); launch(); await waitFor(e => e.type === 'spawn'); await pause(1500)
    assert.equal(events.some(e => e.type === 'navigating'), false)
    assert.equal(JSON.parse(readFileSync(state)).task.status, 'cancelled')
    assert.ok(distance(await position(), stopped) < 0.1)
    return { stopped, persistedStatus: 'cancelled' }
  })
  await reset()
  await test('death: pause then explicit respawn and resume', async () => {
    const { mark, id } = await begin(); await pause(1000)
    await rcon('kill HarnessRunner'); await waitFor(e => e.type === 'death', mark)
    assert.equal(JSON.parse(readFileSync(state)).task.status, 'paused')
    await pause(1000)
    command({ action: 'resume' })
    return completed(mark, id)
  })
  await reset()
  await test('deadline: unreachable task stops', async () => {
    const mark = events.length
    command({ action: 'navigate', goal: { x: 80.5, y: 270, z: 8.5 }, timeoutMs: 1500 })
    const e = await waitFor(e => e.type === 'task_finished', mark)
    assert.equal(e.task.status, 'failed'); assert.match(e.task.reason, /deadline/)
    return { reason: e.task.reason }
  })
  } else { launch(); await waitFor(e => e.type === 'spawn'); await reset() }
  if (process.env.MC_TEST_SKILLS === 'yes') {
    await reset()
    await rcon('fill 10 251 4 19 251 4 minecraft:oak_log')
    await test('T3: gather ten oak logs', async () => {
      const mark = events.length
      command({ action: 'gather', goal: { item: 'oak_log', count: 10 } })
      const e = await waitFor(e => e.type === 'task_finished', mark, 180000)
      assert.equal(e.task.status, 'completed', e.task.reason)
      const inventory = await rcon('data get entity HarnessRunner Inventory')
      assert.match(inventory, /minecraft:oak_log/)
      const counted = await rcon('clear HarnessRunner minecraft:oak_log 0')
      assert.match(counted, /(?:Found|found) 10 /)
      return { inventory, counted }
    })
    await test('T4: craft wooden pickaxe from gathered logs', async () => {
      const mark = events.length
      command({ action: 'craft', goal: { item: 'wooden_pickaxe', count: 1 } })
      const e = await waitFor(e => e.type === 'task_finished', mark, 180000)
      assert.equal(e.task.status, 'completed', e.task.reason)
      const counted = await rcon('clear HarnessRunner minecraft:wooden_pickaxe 0')
      assert.match(counted, /(?:Found|found) 1 /)
      return { counted, inventory: await rcon('data get entity HarnessRunner Inventory') }
    })
    await reset()
    await rcon('fill 10 251 4 19 251 4 minecraft:oak_log')
    await test('gather stop: old skill cannot continue after reconnect', async () => {
      const mark = events.length
      command({ action: 'gather', goal: { item: 'oak_log', count: 10 } })
      await waitFor(e => e.type === 'skill_progress', mark)
      await pause(1000)
      command({ action: 'stop' })
      await waitFor(e => e.type === 'spawn', mark)
      await pause(1000)
      const before = await rcon('data get entity HarnessRunner Inventory')
      await pause(4000)
      const after = await rcon('data get entity HarnessRunner Inventory')
      assert.equal(after, before)
      assert.equal(JSON.parse(readFileSync(state)).task.status, 'cancelled')
      return { inventory: after, status: 'cancelled' }
    })
    await shutdown(); launch(true); await waitFor(e => e.type === 'spawn')
    await test('T1: answer named player in chat', async () => {
      await rcon('whitelist add HarnessWitness')
      const witness = mineflayer.createBot({ host: process.env.MC_HOST, port: Number(process.env.MC_PORT || 25565),
        username: 'HarnessWitness', version: '1.21.4', auth: 'offline' })
      witness.on('error', () => {})
      try {
        await once(witness, 'spawn', { signal: AbortSignal.timeout(30000) })
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no named chat reply')), 10000)
          witness.on('chat', (name, message) => {
            if (name === testUsername && message === 'ack HarnessWitness') { clearTimeout(timer); resolve({ name, message }) }
          })
        })
        witness.chat('!bot ping')
        return await response
      } finally { witness.quit() }
    })
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.stack; console.error(error.message); process.exitCode = 1
} finally {
  if (child?.exitCode === null && !child.signalCode) { command({ action: 'stop' }); await pause(100) }
  await shutdown()
  report.elapsedMs = Date.now() - started
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Report: ${dir}/report.json`)
}
