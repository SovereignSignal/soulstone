import mineflayer from 'mineflayer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Bounded connection probe. No chat, movement, model calls, or reconnect spam.
const host = process.env.MC_HOST
const port = Number(process.env.MC_PORT || 25565)
const version = process.env.MC_VERSION || '1.21.4'
if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set MC_HOST and a valid optional MC_PORT.')
  process.exit(2)
}
const started = Date.now()
const receipt = { startedAt: new Date(started).toISOString(), requestedVersion: version,
  runtime: process.version, status: 'running', events: [] }
const output = fileURLToPath(new URL('../results/', import.meta.url))
mkdirSync(output, { recursive: true })
let finished = false
let bot
let observation
const timeout = setTimeout(() => finish('failed', 'spawn timeout'), 30000)
function event(type, data = {}) {
  receipt.events.push({ elapsedMs: Date.now() - started, type, ...data })
  console.log(JSON.stringify({ type, ...data }))
}
function finish(status, reason) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  clearTimeout(observation)
  receipt.status = status
  receipt.reason = reason
  receipt.elapsedMs = Date.now() - started
  writeFileSync(`${output}probe-${started}.json`, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ status, reason, elapsedMs: receipt.elapsedMs }))
  process.exitCode = status === 'passed' ? 0 : 1
  bot?.quit()
  setTimeout(() => process.exit(process.exitCode), 1000).unref()
}
try {
  bot = mineflayer.createBot({ host, port, username: process.env.MC_USERNAME || 'HarnessProbe',
    auth: 'offline', version: version === 'auto' ? false : version })
  bot.once('login', () => event('login'))
  bot.once('spawn', () => {
    clearTimeout(timeout)
    event('spawn', { negotiatedVersion: bot.version, health: bot.health,
      position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } })
    observation = setTimeout(() => finish('passed', 'spawned and stayed connected for 5 seconds'), 5000)
  })
  bot.on('error', error => finish('failed', error.message))
  bot.on('kicked', () => finish('failed', 'server kicked probe'))
  bot.on('end', () => finish('failed', 'connection ended before observation completed'))
  bot.on('death', () => finish('failed', 'probe died during observation'))
} catch (error) { finish('failed', error.message) }
process.once('SIGINT', () => finish('interrupted', 'operator interrupted'))
process.once('SIGTERM', () => finish('interrupted', 'process terminated'))
