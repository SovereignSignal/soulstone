// Standing ViaProxy launcher for a bot that speaks 1.21.4 in front of a newer Paper server.
//
// Server-side ViaBackwards is not a substitute: with it the bot joins but never
// receives usable position data (onGround false, coordinates frozen). Through
// ViaProxy the same bot walks, paths and places blocks.
//
// The pinned ViaProxy release and the server versions it supports come from
// harness/bridge/compatibility.json, so one launcher serves every supported route
// (26.2 and 26.3 as of 13 October 2026). The adapter jars are built by
// companion/scripts/build-bridge.py and are not committed.
//
// Settings, from the environment:
//   MC_TARGET          server host:port              (default 127.0.0.1:25565)
//   MC_BIND            where the bot connects        (default 127.0.0.1:25599)
//   MC_BOT_NAME        the bot's offline player name (default SoulStone303)
//   MC_TARGET_VERSION  the server's version, one of the pinned routes (default the first)
//   MC_BRIDGE_RELEASE  an adapter release present in the assets, to hold back a world
//                      on an older one (default the pinned release)
//   MC_BRIDGE_ASSETS   the folder holding the jars and compatibility.json (default ../bridge)
//   MC_BRIDGE_HEAP     Java heap (default 512m)    MC_JAVA  the Java to run (default java)
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const assets = process.env.MC_BRIDGE_ASSETS || join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge')
const pin = JSON.parse(readFileSync(join(assets, 'compatibility.json'), 'utf8'))
const VERSION = process.env.MC_TARGET_VERSION || pin.routes[0].version
const route = pin.routes.find(r => r.version === VERSION)
if (!route) { console.error(`No pinned route for ${VERSION}; pinned: ${pin.routes.map(r => r.version).join(', ')}`); process.exit(2) }
const RELEASE = String(process.env.MC_BRIDGE_RELEASE || pin.release).replace(/^v/, '')
const JAR = join(assets, `SoulStoneBridge-${RELEASE}.jar`)
const TARGET = process.env.MC_TARGET || '127.0.0.1:25565'
const BIND = process.env.MC_BIND || '127.0.0.1:25599'
const NAME = process.env.MC_BOT_NAME || 'SoulStone303'
// The offline-mode UUID the server will give this name.
const d = Buffer.from(createHash('md5').update(`OfflinePlayer:${NAME}`).digest())
d[6] = (d[6] & 0x0f) | 0x30; d[8] = (d[8] & 0x3f) | 0x80
const h = d.toString('hex')
const UUID = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`
const dir = mkdtempSync(join(tmpdir(), 'soulstone-bridge-'))
mkdirSync(join(dir, 'plugins'), { mode: 0o700 })
copyFileSync(JAR, join(dir, 'plugins/SoulStoneBridge.jar'))
const child = spawn(process.env.MC_JAVA || 'java', [`-Xmx${process.env.MC_BRIDGE_HEAP || '512m'}`, '-Djava.awt.headless=true', '-jar', JAR,
  'cli', '--bind-address', BIND, '--target-address', TARGET, '--target-version', VERSION,
  '--proxy-online-mode', 'false', '--auth-method', 'NONE', '--log-ips', 'false',
  '--simple-voice-chat-support', 'false', '--rewrite-transfer-packets', 'false'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] })
child.stdin.on('error', () => {})
child.stdin.write(JSON.stringify({ uuid: UUID, clientProtocol: pin.clientProtocol, serverProtocol: route.protocol }) + '\n')
createInterface({ input: child.stdout }).on('line', l => {
  const i = l.indexOf('SOULSTONE_BRIDGE '); if (i < 0) return
  try { const v = JSON.parse(l.slice(i + 17))
    if (v.type === 'ready') console.log(`bridge ready ${BIND} -> ${TARGET} (${VERSION} -> ${pin.clientVersion}, adapter ${RELEASE}) as ${NAME}`)
  } catch {}
})
child.on('exit', c => { console.error('bridge exited', c); process.exit(c ?? 1) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })
