import '../physics-margin.js'
import {Vec3} from 'vec3'
import {DayRoutine} from './day-routine.js'
import {loadSetup} from './setup.js'
import {MinecraftAccounts,linkedAccountAuth} from './minecraft-accounts.js'
import {startVersionBridge,bridgeRouteForVersion} from './version-bridge.js'
import {connectionFailure,checkConnection} from './connection-check.js'
import {subscriptionKinds,subscriptionStatus} from './subscriptions.js'
import {ModelProfiles} from './providers.js'
import {surroundings} from './probe.js'
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { Runner } from '../runner.js'
import { LocalPlanner } from './planner.js'
import { Teammate } from './controller.js'
import { startLocalModel } from './runtime.js'
import { EpisodeRecorder } from './episodes.js'

// Packaged launches use a validated profile, never a developer .env file.
const setup = process.env.MC_SETUP_FILE ? loadSetup(process.env.MC_SETUP_FILE) : null
if (setup) process.umask(0o077)
let authentication = null
let connectionIssue = null
let lastConnectionFailure = null
let versionBridge = null, startingGame = false
const owner = setup?.owner ?? process.env.MC_OWNER
if (!/^[A-Za-z0-9_]{1,16}$/.test(owner || '')) throw new Error('Set MC_OWNER in .env')
const linkedAuth=setup?.minecraftAccountId ? linkedAccountAuth(new MinecraftAccounts(process.env.MC_ACCOUNTS_DIR),setup.minecraftAccountId) : undefined
const runner = new Runner({ host: setup?.host ?? process.env.MC_HOST, port: setup?.port ?? Number(process.env.MC_PORT || 25565), version: setup?.version ?? process.env.MC_VERSION ?? '1.21.4',
  authenticate:linkedAuth,
  username: setup?.username ?? process.env.MC_USERNAME ?? 'HarnessRunner', auth:setup?.auth ?? 'offline', worldId:setup?.id, profileIdentity:setup?.identity, profilesFolder:resolve('state/auth'), onMsaCode:code=>{authentication={code:code.user_code,url:'https://www.microsoft.com/link',expiresAt:Date.now()+Number(code.expires_in||900)*1000}}, owner, chatControl: true, statePath: resolve(process.env.MC_STATE || 'state/companion.json') })
// Every vanilla route answers a correctly predicted click with silence and a
// mismatched revision with a full sync, so every click asks for the full sync.
// Pinned versions never reach the auto-detect branch that used to set this.
runner.inventoryResync=true
// A process restart never silently replays a model plan or a half-completed skill.
if (runner.task?.kind !== 'follow' && ['running', 'paused'].includes(runner.task?.status)) runner.stop()
const recorder = process.env.MC_RECORD_EPISODES === '0' ? null : new EpisodeRecorder(resolve('state/episodes'), message => console.error(message))
const teammate = new Teammate(runner, new LocalPlanner({ model: process.env.MC_MODEL || 'minecraft-teammate', url: process.env.MC_MODEL_URL }), resolve('state/teammate.json'), recorder)
const profiles = new ModelProfiles(resolve('state/models.json'), setup ? {id:'subscription-default',kind:setup.provider,label:setup.provider==='codex'?'Codex subscription':'Claude subscription',model:setup.model,url:'',maxTokens:4096} : {id:'local-default',kind:'local',label:'Local · LM Studio',model:teammate.planner.model,url:teammate.planner.url,maxTokens:4096})
teammate.planner.profiles = profiles
// What the teammate says is said in the game too, and a line the owner addresses
// to it in chat is a request like any typed into the companion.
let spoken = new Set(teammate.messages.map(m => m.id))
teammate.on('change', () => {
  for (const m of teammate.messages) if (!spoken.has(m.id) && m.role === 'assistant') runner.say(m.text)
  spoken = new Set(teammate.messages.map(m => m.id))
})
runner.on('chat_request', ({ text }) => { void teammate.submit(text).catch(e => runner.say(e.message)) })
const routine = new DayRoutine(teammate,resolve('state/day-routine.json'))
void startLocalModel({ binary: process.env.MC_LMS_BINARY, key: process.env.MC_MODEL_KEY, identifier: process.env.MC_MODEL || 'minecraft-teammate' }).catch(e => console.error('Local model startup:', e.message))
const token = process.env.MC_COMPANION_TOKEN || randomBytes(32).toString('hex')
let modelReady = false
async function checkModel() {
  if(subscriptionKinds.includes(profiles.current.kind)) {const id=profiles.active;const status=await subscriptionStatus(profiles.current.kind);if(id===profiles.active)modelReady=status.ready;return}
  if(profiles.current.kind !== 'local') { modelReady = !!profiles.key; return }
  const active = profiles.active
  try {
    const url = new URL('../models', profiles.current.url)
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const data = await response.json()
    if(active !== profiles.active)return
    modelReady = response.ok && data.data?.some(m => m.id === teammate.planner.model) === true
  } catch { if(active === profiles.active)modelReady = false }
}
void checkModel()
const modelTimer = setInterval(checkModel, 15000)
const clientSequences = new Map()
function authorized(req) {
  const value = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from(`Bearer ${token}`)
  return value.length === expected.length && timingSafeEqual(value, expected)
}
const server = http.createServer(async (req,res) => {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control','no-store')
  const send = (code,data) => { res.writeHead(code); res.end(JSON.stringify(data)) }
  // No browser origins or cross-origin mutation. Only the native client receives the token.
  if (req.headers.origin || !authorized(req)) return send(403,{error:'Unauthorized'})
  if (req.method === 'GET' && req.url.split('?')[0] === '/block') {
    const q=new URL(req.url,'http://x').searchParams,c=['x','y','z'].map(k=>Number(q.get(k)))
    if(!c.every(Number.isFinite))return send(400,{error:'x, y and z are required'})
    const b=runner.bot?.blockAt?.(new Vec3(...c.map(Math.floor)))
    return send(200, b?{name:b.name,box:b.boundingBox,position:b.position,light:b.light,skyLight:b.skyLight,properties:b.getProperties?.()}:{name:null,loaded:false})
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/surroundings') {
    const q=new URL(req.url,'http://x').searchParams,n=(k,d,max)=>Math.min(max,Math.max(0,Number(q.get(k))||d))
    return send(200, surroundings(runner.bot,{radius:n('radius',1,6),below:n('below',1,6),above:n('above',2,6)}))
  }
  if (req.method === 'GET' && req.url === '/state') return send(200,{ ...teammate.snapshot(), worldId:setup?.id??null, survivalSession:routine.snapshot(), botName:runner.bot?.username??null, minecraftVersion:versionBridge?.serverVersion||runner.bot?.version||null, translation:versionBridge?`Compatibility mode · client ${versionBridge.version}`:null, connectionIssue, authentication:authentication && authentication.expiresAt>Date.now()?authentication:null, modelReady, providerKind:profiles.current.kind, modelLabel:profiles.current.label })
  if (req.method === 'GET' && req.url === '/models') return send(200,profiles.snapshot())
  if (req.method !== 'POST' || !['/message','/resume','/respawn','/stop','/reconnect','/shutdown','/models','/credentials','/survival-session'].includes(req.url)) return send(404,{error:'Not found'})
  try {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10000) throw new Error('Message too large') }
    const payload = JSON.parse(body || '{}')
    const { text, client, sequence } = payload
    if (client !== undefined || sequence !== undefined) {
      const order = Number(sequence)
      if (typeof client !== 'string' || client.length > 64 || !Number.isSafeInteger(order) || order < 1) throw new Error('Invalid request sequence')
      if (order <= (clientSequences.get(client) || 0)) return send(409, { error: 'Superseded request' })
      if (clientSequences.size >= 32 && !clientSequences.has(client)) throw new Error('Too many clients')
      clientSequences.set(client, order)
    }
    if (closing) return send(409,{error:'Service is shutting down'})
    if (req.url === '/shutdown') {send(202,{ok:true});close(true);return}
    if (req.url === '/reconnect') {
      if (closing) return send(409,{error:'Service is shutting down'})
      if (runner.closed && runner.connectionExhausted) {
        routine.stop('Connection restarted; start a new survival session explicitly')
        teammate.interrupt('Minecraft reconnected. Resume to re-observe the saved request.')
        void startGame()
      }
      return send(202,{ok:true,connected:runner.ready})
    }
    if (req.url === '/survival-session') return send(200,routine.start(payload.days))
    if (req.url !== '/credentials') routine.stop('A new user command took control')
    if(req.url==='/respawn'){
      if(!teammate.snapshot().dead)return send(409,{error:'The agent is not dead'})
      teammate.respawn();return send(202,{ok:true})
    }
    if (req.url === '/credentials') {profiles.unlock(payload.id,payload.apiKey,payload.url);void checkModel();return send(200,{ok:true})}
    if (req.url === '/models') {
      const previous=JSON.stringify(profiles.current)
      const result=profiles.save(payload, payload.apiKey || '', payload.activate !== false)
      if(previous!==JSON.stringify(profiles.current)) {
        teammate.cancel(['thinking','acting','retreating','defending'].includes(teammate.phase));modelReady=false;void checkModel()
      }
      return send(200,result)
    }
    if (req.url === '/resume') {
      if(!teammate.snapshot().canResume)return send(409,{error:teammate.requestProgress?.reviewRequired||'This request cannot be resumed'})
      void teammate.resume().catch(e=>console.error(e.message));return send(202,{ok:true})
    }
    if (req.url === '/stop') { teammate.stop(); return send(200,{ok:true}) }
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Invalid message')
    void teammate.submit(text).catch(e=>console.error(e.message)); send(202,{ok:true})
  } catch (e) { send(400,{error:e.message}) }
})
server.requestTimeout = 10000
server.listen(Number(process.env.MC_COMPANION_PORT || 0),'127.0.0.1',()=> {
  const info = { url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid }
  mkdirSync('state',{recursive:true}); writeFileSync('state/companion-api.json.tmp',JSON.stringify(info),{mode:0o600});renameSync('state/companion-api.json.tmp','state/companion-api.json')
  console.log(JSON.stringify({type:'companion_ready',port:server.address().port}))
  void startGame()
})
async function startGame() {
 if(startingGame || closing)return
 startingGame=true
 try {
  if(versionBridge){await versionBridge.close();versionBridge=null}
  if(setup && (setup.version==='auto'||bridgeRouteForVersion(setup.version))) {
   const status=await checkConnection(setup)
   if(status.status!=='reachable')throw new Error(status.message)
   if(status.route==='bridge') {
    if(setup.auth!=='microsoft'||!setup.minecraftAccountId)throw new Error(`Link a Minecraft Java account in Worlds to use ${status.serverVersion} compatibility mode.`)
    connectionIssue=`Starting Minecraft ${status.serverVersion} compatibility mode…`
    versionBridge=await startVersionBridge({host:setup.host,port:setup.port,serverVersion:status.serverVersion,store:new MinecraftAccounts(process.env.MC_ACCOUNTS_DIR),accountId:setup.minecraftAccountId,onFailure:message=>{
     if(closing)return
     lastConnectionFailure=message;runner.close();runner.connectionExhausted=true;connectionIssue=message
    }})
    runner.options.host=versionBridge.host;runner.options.port=versionBridge.port;runner.options.version=versionBridge.version
   } else {runner.options.host=setup.host;runner.options.port=setup.port;runner.options.version=setup.version==='auto'?false:setup.version}
  }
  if(closing){await versionBridge?.close();return}
  if(runner.closed)runner.reconnect();else runner.start()
 }catch(error){runner.close();runner.connectionExhausted=true;connectionIssue=error.message}
 finally{startingGame=false}
}
runner.on('event', e=>{
  if(e.type==='death'){connectionIssue=null;lastConnectionFailure=null;authentication=null}
  if(['spawn','connection_error','kicked'].includes(e.type))authentication=null
  if(e.type==='spawn'){connectionIssue=null;lastConnectionFailure=null}
  if(e.type==='connecting')connectionIssue=lastConnectionFailure||'Connecting to Minecraft…'
  if(e.type==='disconnected')connectionIssue=lastConnectionFailure||'Minecraft disconnected. Retrying the server connection…'
  if(['connection_error','kicked'].includes(e.type)){lastConnectionFailure=connectionFailure(e.reason);connectionIssue=lastConnectionFailure}
  if(e.type==='kicked' && /name_taken|duplicate_login/.test(e.reason||'')){runner.close();runner.connectionExhausted=true}
  if(e.type==='connection_exhausted')connectionIssue=(lastConnectionFailure?lastConnectionFailure+' ':'')+'Connection attempts stopped. Open Agent connection and choose Connect agent after correcting the problem.'
  console.log(JSON.stringify(e))
})
let closing = false
function close(switching=false) { if(closing)return; closing=true; clearInterval(modelTimer); routine.stop('Service stopped; explicit restart required'); teammate.interrupt(); if(switching)runner.stop(); runner.close(); server.close(); void (async()=>{await versionBridge?.close();setTimeout(()=>process.exit(0),1000).unref()})() }
process.on('SIGTERM',()=>close()); process.on('SIGINT',()=>close())
