import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { Runner } from './runner.js'

try {
  const runner = new Runner({ host: process.env.MC_HOST, port: Number(process.env.MC_PORT || 25565),
    version: process.env.MC_VERSION || '1.21.4', username: process.env.MC_USERNAME || 'HarnessRunner',
    statePath: resolve(process.env.MC_STATE || 'state/task.json'),
    chatControl: process.env.MC_CHAT_CONTROL === 'yes', owner: process.env.MC_OWNER || '' })
  runner.on('event', event => {
    if (event.type === 'connection_exhausted') process.exitCode = 1
    console.log(JSON.stringify(event))
  })
  const input = createInterface({ input: process.stdin })
  input.on('line', line => {
    try { runner.command(JSON.parse(line)) } catch (error) { console.log(JSON.stringify({ type: 'command_error', reason: error.message })) }
  })
  input.on('close', () => runner.close())
  runner.on('closed', () => { input.close(); setTimeout(() => process.exit(process.exitCode || 0), 1000).unref() })
  process.once('SIGTERM', () => runner.close())
  process.once('SIGINT', () => runner.close())
  runner.start()
} catch (error) { console.error(error.message); process.exitCode = 1 }
