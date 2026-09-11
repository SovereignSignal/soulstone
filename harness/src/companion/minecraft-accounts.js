import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,rmSync,existsSync,chmodSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import prismarineAuth from 'prismarine-auth'
import microsoftAuth from 'minecraft-protocol/src/client/microsoftAuth.js'

const {Authflow,Titles}=prismarineAuth
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const accountAuthOptions={flow:'live',authTitle:Titles.MinecraftNintendoSwitch,deviceType:'Nintendo'}
export class AccountError extends Error {
 constructor(code,message){super(message);this.code=code}
}
export function accountFailure(error) {
 if(error instanceof AccountError)return {type:'error',code:error.code,message:error.message}
 const text=String(error?.message||'')
 if(/2148916233|no xbox account/i.test(text))return {type:'error',code:'xbox_profile',message:'Finish the Xbox profile for this Microsoft account, then try linking again.'}
 if(/2148916238|child|family|age|multiplayer.*disabled/i.test(text))return {type:'error',code:'permissions',message:'Check this account’s Microsoft family and Xbox multiplayer permissions, then try again.'}
 if(/expired|code_expired/i.test(text))return {type:'error',code:'expired',message:'The sign-in code expired. Click Link Minecraft account to get a new code.'}
 if(/declined|denied|cancel/i.test(text))return {type:'error',code:'declined',message:'Microsoft sign-in was not completed. You can try again.'}
 return {type:'error',code:'unavailable',message:'Could not verify Minecraft access. Check your internet connection and try again. No account was linked.'}
}
export function verifyJavaProfile(result,expectedUUID) {
 const profile=result?.profile
 if(!profile||!/^[0-9a-f]{32}$/i.test(profile.id||'')||!/^[A-Za-z0-9_]{1,16}$/.test(profile.name||''))throw new AccountError('java_profile','No Java player profile was found. Check that this Microsoft account has Minecraft Java access and finish its profile in the Minecraft Launcher, then try again.')
 if(expectedUUID&&profile.id.toLowerCase()!==expectedUUID.toLowerCase())throw new AccountError('wrong_account','Microsoft returned a different Minecraft player. Link the intended bot account in Worlds before connecting.')
 return {uuid:profile.id.toLowerCase(),name:profile.name}
}
export async function verifiedJavaToken(flow,options={},expectedUUID) {
 // Authflow silently converts every profile-fetch error into an absent profile.
 // Fetch through its existing manager so HTTP/network failures stay distinct.
 const result=await flow.getMinecraftJavaToken({...options,fetchProfile:false})
 let timer
 try {
  result.profile=await Promise.race([
   flow.mca.fetchProfile(result.token),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Profile request timed out')),20000)})
  ])
 }catch(error){
  const status=Number(/^(\d{3})\b/.exec(String(error?.message||''))?.[1])
  if(status===404)throw new AccountError('java_profile','Minecraft reports no Java player profile for the Microsoft account used in this sign-in (HTTP 404). Check the purchase account and finish its Java profile, then link again.')
  if(status===401)throw new AccountError('relink','Minecraft rejected this sign-in session (HTTP 401). Link the account again.')
  if(status===403)throw new AccountError('profile_denied','Minecraft refused access to this Java profile (HTTP 403). This does not confirm a missing purchase. Retry linking; if it persists, check account access and Minecraft service availability.')
  if(status===429)throw new AccountError('profile_rate_limit','Minecraft is limiting profile checks (HTTP 429). Wait a few minutes before linking again.')
  throw new AccountError('profile_unavailable',`Minecraft’s Java profile check ${status>=500?'is temporarily unavailable (HTTP '+status+')':'could not complete'}. Check your connection and retry linking. This does not mean your account lacks Java Edition.`)
 }finally{clearTimeout(timer)}
 try{verifyJavaProfile(result,expectedUUID)}catch(error){
  if(error.code==='java_profile')throw new AccountError('profile_response','Minecraft returned incomplete Java profile data. Retry linking; no account was saved.')
  throw error
 }
 return result
}
export class MinecraftAccounts {
 constructor(root){if(typeof root!=='string'||!root||resolve(root)!==root)throw new Error('Invalid account storage');this.root=root}
 directory(id){if(!uuid.test(id||''))throw new Error('Invalid account ID');return join(this.root,id)}
 safeDirectory(path){if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())throw new Error('Invalid account directory')}
 prepare(){mkdirSync(this.root,{recursive:true,mode:0o700});this.safeDirectory(this.root);chmodSync(this.root,0o700)}
 read(id){
  this.safeDirectory(this.root);const dir=this.directory(id);this.safeDirectory(dir)
  const file=join(dir,'account.json');if(lstatSync(file).isSymbolicLink())throw new Error('Invalid account file')
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(value.id!==id||!Number.isFinite(value.verifiedAt))throw new Error('Invalid linked account')
  const player=verifyJavaProfile({profile:{id:value.uuid,name:value.name}})
  return {id,...player,verifiedAt:value.verifiedAt}
 }
 list(){
  if(!existsSync(this.root))return [];this.safeDirectory(this.root)
  return readdirSync(this.root).filter(id=>uuid.test(id)&&existsSync(join(this.directory(id),'account.json'))).map(id=>this.read(id)).sort((a,b)=>a.name.localeCompare(b.name))
 }
 begin(){this.prepare();const id=randomUUID();mkdirSync(this.directory(id),{mode:0o700});return id}
 commit(id,result){
  const player=verifyJavaProfile(result),dir=this.directory(id);this.safeDirectory(dir)
  const existing=this.list().find(account=>account.uuid===player.uuid)
  const target=existing?this.directory(existing.id):dir
  // Relinking refreshes one stable account reference across all its worlds.
  // Cache filenames are identical inside each isolated account directory.
  if(existing&&existing.id!==id){
   for(const name of readdirSync(dir)){
    if(!/^[a-f0-9]+_(?:msal|live|sisu|xbl|bed|mca|mcs|pfb)-cache\.json$/.test(name))continue
    const source=join(dir,name);if(lstatSync(source).isSymbolicLink()||!lstatSync(source).isFile())throw new Error('Invalid credential cache')
    const temp=join(target,randomUUID()+'.pending')
    writeFileSync(temp,readFileSync(source),{mode:0o600,flag:'wx'});renameSync(temp,join(target,name))
   }
  }
  const value={id:existing?.id??id,...player,verifiedAt:Date.now()},file=join(target,'account.json'),temp=join(target,randomUUID()+'.pending')
  writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,file)
  if(existing&&existing.id!==id)this.remove(id)
  return value
 }
 remove(id){this.safeDirectory(this.root);const dir=this.directory(id);if(existsSync(dir)){this.safeDirectory(dir);rmSync(dir,{recursive:true})}}
 login(id,codeCallback){this.safeDirectory(this.root);const dir=this.directory(id);this.safeDirectory(dir);return new Authflow('soulstone',dir,accountAuthOptions,codeCallback)}
}

// Check the identity before minecraft-protocol opens the game connection.
// It remains responsible for certificates, session setup and encryption.
export function linkedAccountAuth(store,id,{authenticate=microsoftAuth.authenticate}={}) {
 const expected=store.read(id)
 let refreshNext=false,profileSessionRefreshed=false
 return (client,options)=>{
  const flow=store.login(id,()=>{throw new AccountError('relink','Minecraft sign-in expired. Open Agent connection and link the bot account again.')})
  // Newly created Java profiles can verify successfully while an older
  // Minecraft token is still rejected by the multiplayer session service.
  // Refresh once on the existing runner retry, without another device login.
  client.once('error',error=>{
   if(!profileSessionRefreshed&&/profile not found.*restart your launcher/i.test(String(error?.message||'')))refreshNext=true
  })
  if(refreshNext){flow.mca.forceRefresh=true;refreshNext=false;profileSessionRefreshed=true}
  client.authflow={getMinecraftJavaToken:async args=>{
   return verifiedJavaToken(flow,args,expected.uuid)
  }}
  void authenticate(client,options).catch(error=>{client.emit('error',new Error(accountFailure(error).message));client.end('Minecraft account sign-in required')})
 }
}
