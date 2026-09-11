import {spawn} from 'node:child_process'
import {existsSync,mkdirSync,readFileSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {createInterface} from 'node:readline'
import {verifiedJavaToken,AccountError} from './minecraft-accounts.js'

const assets=fileURLToPath(new URL('../../bridge/',import.meta.url))
const jarName='ViaProxy-3.4.12.jar'
const jarHash='32ce9ad871aeb03286823c29da262ebd75992864e7857db283f103525c7fc0cb'
export const bridgeVersion='26.2'
export const bridgeProtocol=776
export const bridgeClientVersion='1.21.4'
export function bridgeJava() {
 for(const name of ['java-runtime-epsilon','java-runtime-delta']) {
  const path=join(homedir(),'Library/Application Support/minecraft/runtime',name,'mac-os-arm64',name,'jre.bundle/Contents/Home/bin/java')
  if(existsSync(path))return path
 }
 return null
}
export function bridgeAvailable(){return !!bridgeJava()&&existsSync(join(assets,jarName))&&existsSync(join(assets,'SoulStoneBridge.jar'))}
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
export async function startVersionBridge({host,port,store,accountId,onFailure=()=>{},onEvent=()=>{}}) {
 if(!bridgeAvailable())throw new Error('Java 26.2 needs SoulStone’s compatibility helper and the Java runtime installed by Minecraft Launcher. Launch Minecraft once, then try again.')
 const jar=join(assets,jarName)
 if(createHash('sha256').update(readFileSync(jar)).digest('hex')!==jarHash)throw new Error('Minecraft compatibility helper failed its integrity check. Reinstall SoulStone.')
 const account=store.read(accountId),authorize=sessionJoinAuthorizer(store,accountId)
 const uuid=account.uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5')
 const dir=mkdtempSync(join(tmpdir(),'soulstone-bridge-'));mkdirSync(join(dir,'plugins'),{mode:0o700});copyFileSync(join(assets,'SoulStoneBridge.jar'),join(dir,'plugins/SoulStoneBridge.jar'))
 let child,closed=false,ready=false,exitPromise
 const close=async()=>{
  if(closed)return exitPromise
  closed=true
  if(child&&child.exitCode===null&&child.signalCode===null){child.stdin.end();child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),3000);kill.unref();await exitPromise;clearTimeout(kill)}
  rmSync(dir,{recursive:true,force:true})
 }
 try {
  child=spawn(bridgeJava(),['-Xmx512m','-Djava.awt.headless=true','-jar',join(assets,'SoulStoneBridge.jar'),'cli','--bind-address','127.0.0.1:0','--target-address',host.includes(':')?`[${host}]:${port}`:`${host}:${port}`,'--target-version',bridgeVersion,'--proxy-online-mode','true','--auth-method','NONE','--log-ips','false','--simple-voice-chat-support','false','--rewrite-transfer-packets','false'],{cwd:dir,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:homedir()}})
  exitPromise=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)})
  child.stdin.on('error',()=>{})
  child.stdin.write(JSON.stringify({uuid})+'\n')
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
    if(value.type==='ready'&&!ready&&Number.isInteger(value.port)&&value.port>0&&value.port<65536){ready=true;clearTimeout(timer);resolve(value.port)}
    else if(value.type==='join'&&typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id)) {
     void authorize(value).then(()=>{onEvent('session_authorized');if(!closed)child.stdin.write(JSON.stringify({id:value.id,ok:true})+'\n')},()=>{onEvent('session_rejected');if(!closed)child.stdin.write(JSON.stringify({id:value.id,ok:false})+'\n')})
    }
   })
  })
  return {host:'127.0.0.1',port:bound,version:bridgeClientVersion,serverVersion:bridgeVersion,pid:child.pid,close}
 }catch(error){await close();throw error}
}
