import { resolve } from 'node:path'
import { Runner } from './runner.js'

if (!/^[A-Za-z0-9_]{1,16}$/.test(process.env.MC_OWNER || '')) throw new Error('Set MC_OWNER to the Minecraft player who controls this companion')
const runner = new Runner({ host: process.env.MC_HOST, port: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || '1.21.4', username: process.env.MC_USERNAME || 'HarnessRunner',
  statePath: resolve(process.env.MC_STATE || 'state/play.json'), chatControl: true, owner: process.env.MC_OWNER || '' })
runner.on('event', event => console.log(JSON.stringify(event)))
runner.on('closed', () => setTimeout(() => process.exit(0), 1000).unref())
process.once('SIGTERM', () => runner.close())
process.once('SIGINT', () => runner.close())
if (!runner.task && process.env.MC_OWNER) runner.follow(process.env.MC_OWNER)
runner.start()
