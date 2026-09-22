import {spawn} from 'node:child_process'
import {findJava} from './platform.js'
import {subscriptionEnv} from './subscriptions.js'
import minecraftData from 'minecraft-data'
import {existsSync,mkdirSync,readFileSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {createInterface} from 'node:readline'
import {verifiedJavaToken,AccountError} from './minecraft-accounts.js'

const assets=fileURLToPath(new URL('../../bridge/',import.meta.url))
export const bridgeManifest=JSON.parse(readFileSync(join(assets,'compatibility.json'),'utf8'))
const validVersion=value=>typeof value==='string'&&/^\d+\.\d+(\.\d+)?$/.test(value)
const routes=bridgeManifest.routes
if(bridgeManifest.schema!==1 || !/^ViaProxy-[0-9.]+\.jar$/.test(bridgeManifest.jar) || !/^[a-f0-9]{64}$/.test(bridgeManifest.sha256)
 || !Array.isArray(routes) || !routes.length || routes.some(r=>!r||!validVersion(r.version)||!Number.isInteger(r.protocol)||r.protocol<=0)
 || new Set(routes.map(r=>r.version)).size!==routes.length || new Set(routes.map(r=>r.protocol)).size!==routes.length
 || !validVersion(bridgeManifest.clientVersion) || minecraftData(bridgeManifest.clientVersion)?.version.version!==bridgeManifest.clientProtocol)throw new Error('Invalid Minecraft compatibility manifest')
const jarName=bridgeManifest.jar,jarHash=bridgeManifest.sha256
const adapterName=jarName.replace('ViaProxy-','SoulStoneBridge-')
export const bridgeRoutes=Object.freeze(bridgeManifest.routes.map(r=>Object.freeze({...r})))
// Keep the default route for existing callers; connections select their detected route.
export const bridgeVersion=bridgeRoutes.at(-1).version
export const bridgeProtocol=bridgeRoutes.at(-1).protocol
export const bridgeClientVersion=bridgeManifest.clientVersion
export const bridgeRouteForVersion=version=>bridgeRoutes.find(r=>r.version===version)
export const bridgeRouteForProtocol=protocol=>bridgeRoutes.find(r=>r.protocol===protocol)
export function bridgeJava() { return findJava() }
export function bridgeAvailable(){return !!bridgeJava()&&existsSync(join(assets,jarName))&&existsSync(join(assets,adapterName))}
export function sessionJoinAuthorizer(store,id,{request=fetch}={}) {
 const expected=store.read(id)
 return async value=>{
  if(!value||typeof value.hash!=='string'||!/^-[0-9a-f]{1,40}$|^[0-9a-f]{1,40}$/.test(value.hash)||typeof value.uuid!=='string'||value.uuid.replaceAll('-','').toLowerCase()!==expected.uuid)throw new Error('Invalid bridge identity or session challenge')
  const flow=store.login(id,()=>{throw new AccountError('relink','Minecraft sign-in expired. Link the account again in Worlds.')})
  const result=await verifiedJavaToken(flow,{},expected.uuid)
  if(typeof result.token!=='string'||!result.token)throw new Error('Minecraft access is unavailable')
  const response=await request('https://sessionserver.mojang.com/session/minecraft/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:result.token,selectedProfile:expected.uuid,serverId:value.hash}),signal:AbortSignal.timeout(15000),redirect:'error'})
  if(response.status!==204)throw new Error('Minecraft session authentication was rejected')
 }
}
export async function startVersionBridge({host,port,store,accountId,serverVersion=bridgeVersion,onFailure=()=>{},onEvent=()=>{}}) {
 const route=bridgeRouteForVersion(serverVersion)
 if(!route)throw new Error(`Java ${serverVersion} has no verified compatibility route in this build.`)
 if(!bridgeAvailable())throw new Error(`Java ${serverVersion} needs SoulStone’s compatibility helper and the Java runtime installed by Minecraft Launcher. Launch Minecraft once, then try again.`)
 const jar=join(assets,jarName)
 if(createHash('sha256').update(readFileSync(jar)).digest('hex')!==jarHash)throw new Error('Minecraft compatibility helper failed its integrity check. Reinstall SoulStone.')
 const account=store.read(accountId),authorize=sessionJoinAuthorizer(store,accountId)
 const uuid=account.uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5')
 const dir=mkdtempSync(join(tmpdir(),'soulstone-bridge-'));mkdirSync(join(dir,'plugins'),{mode:0o700});copyFileSync(join(assets,adapterName),join(dir,'plugins/SoulStoneBridge.jar'))
 let child,closed=false,ready=false,exitPromise
 const close=async()=>{
  if(closed)return exitPromise
  closed=true
  if(child&&child.exitCode===null&&child.signalCode===null){child.stdin.end();child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),3000);kill.unref();await exitPromise;clearTimeout(kill)}
  rmSync(dir,{recursive:true,force:true})
 }
 try {
  child=spawn(bridgeJava(),['-Xmx512m','-Djava.awt.headless=true','-jar',join(assets,adapterName),'cli','--bind-address','127.0.0.1:0','--target-address',host.includes(':')?`[${host}]:${port}`:`${host}:${port}`,'--target-version',route.version,'--proxy-online-mode','true','--auth-method','NONE','--log-ips','false','--simple-voice-chat-support','false','--rewrite-transfer-packets','false'],{cwd:dir,stdio:['pipe','pipe','pipe'],windowsHide:true,env:subscriptionEnv()})
  exitPromise=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)})
  child.stdin.on('error',()=>{})
  child.stdin.write(JSON.stringify({uuid,clientProtocol:bridgeManifest.clientProtocol,serverProtocol:route.protocol})+'\n')
  const bound=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Minecraft compatibility helper did not become ready.')),30000)
   child.once('error',()=>{clearTimeout(timer);reject(new Error('Could not start Minecraft compatibility helper.'))})
   child.once('exit',()=>{clearTimeout(timer);if(!ready)reject(new Error('Minecraft compatibility helper exited before startup.'));else if(!closed)onFailure('Minecraft compatibility helper stopped. Open Agent connection and choose Connect agent.')})
   const lines=createInterface({input:child.stdout})
   child.stderr.on('data',()=>{}) // No upstream diagnostics are sent to the native app.
   lines.on('line',line=>{
    const offset=line.indexOf('SOULSTONE_BRIDGE ');if(offset<0)return
    if(line.length>2048)return
    let value;try{value=JSON.parse(line.slice(offset+17))}catch{return}
    if(value.type==='ready'&&!ready&&Number.isInteger(value.port)&&value.port>0&&value.port<65536){if(value.serverProtocol!==route.protocol||value.clientProtocol!==bridgeManifest.clientProtocol){clearTimeout(timer);reject(new Error('Minecraft compatibility helper reported a different protocol route. Rebuild SoulStone.'));return}ready=true;clearTimeout(timer);resolve(value.port)}
    else if(value.type==='unsupported_route'){clearTimeout(timer);reject(new Error(`The compatibility helper cannot translate Minecraft ${bridgeClientVersion} to ${route.version}. Upgrade the verified bundle.`))}
    else if(value.type==='join'&&typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id)) {
     void authorize(value).then(()=>{onEvent('session_authorized');if(!closed)child.stdin.write(JSON.stringify({id:value.id,ok:true})+'\n')},()=>{onEvent('session_rejected');if(!closed)child.stdin.write(JSON.stringify({id:value.id,ok:false})+'\n')})
    }
   })
  })
  return {host:'127.0.0.1',port:bound,version:bridgeClientVersion,serverVersion:route.version,pid:child.pid,close}
 }catch(error){await close();throw error}
}
