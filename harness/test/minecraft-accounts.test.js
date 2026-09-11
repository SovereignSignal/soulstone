import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync,statSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {EventEmitter,once} from 'node:events'
import {MinecraftAccounts,AccountError,accountFailure,verifyJavaProfile,linkedAccountAuth,verifiedJavaToken} from '../src/companion/minecraft-accounts.js'
import {validateSetup} from '../src/companion/setup.js'

const java={token:'private-access-token',profile:{id:'a'.repeat(32),name:'SoulTeammate'}}
function fixture(){const root=mkdtempSync(join(tmpdir(),'soul-accounts-'));return {root,store:new MinecraftAccounts(join(root,'accounts')),close:()=>rmSync(root,{recursive:true,force:true})}}
test('account linking publishes only a verified Java identity, keeps tokens out of metadata, and restricts files',()=>{
 const f=fixture();try{
  const id=f.store.begin();assert.deepEqual(f.store.list(),[])
  const account=f.store.commit(id,java,'HumanPlayer')
  assert.equal(account.name,'SoulTeammate');assert.equal(f.store.list()[0].uuid,java.profile.id)
  assert.equal(statSync(f.store.root).mode&0o777,0o700)
  assert.equal(statSync(join(f.store.directory(id),'account.json')).mode&0o777,0o600)
  assert.ok(!readFileSync(join(f.store.directory(id),'account.json'),'utf8').includes(java.token))
  assert.throws(()=>f.store.directory('../escape'))
 }finally{f.close()}
})
test('linking accepts a previously human account while rejecting missing profiles and wrong identities',()=>{
 assert.throws(()=>verifyJavaProfile({profile:{}}),e=>e.code==='java_profile')
 assert.throws(()=>verifyJavaProfile(java,'b'.repeat(32)),e=>e.code==='wrong_account')
 const f=fixture();try{const id=f.store.begin();assert.equal(f.store.commit(id,java).name,'SoulTeammate');assert.equal(f.store.list().length,1);f.store.remove(id);assert.equal(existsSync(f.store.directory(id)),false)}finally{f.close()}
})
test('account reads reject symlinks and mismatched metadata; removing one account preserves others',()=>{
 const f=fixture();try{
  const first=f.store.begin(),second=f.store.begin();f.store.commit(first,java);f.store.commit(second,{profile:{id:'b'.repeat(32),name:'AnotherBot'}})
  f.store.remove(first);assert.equal(f.store.list().length,1)
  const file=join(f.store.directory(second),'account.json'),other=join(f.root,'outside.json')
  writeFileSync(other,readFileSync(file));rmSync(file);symlinkSync(other,file)
  assert.throws(()=>f.store.read(second),/Invalid account file/)
  rmSync(file);writeFileSync(file,JSON.stringify({id:first,uuid:java.profile.id,name:'SoulTeammate',verifiedAt:1}))
  assert.throws(()=>f.store.read(second),/Invalid linked account/)
 }finally{f.close()}
})
test('linked account auth verifies identity before delegating the game connection',async()=>{
 const f=fixture();try{
  const id=f.store.begin();f.store.commit(id,java)
  const certificate={privateKey:'private-certificate'},client=new EventEmitter();client.end=()=>{}
  f.store.login=()=>({getMinecraftJavaToken:async()=>({...java,certificates:certificate}),mca:{fetchProfile:async()=>java.profile}})
  let delivered;const auth=linkedAccountAuth(f.store,id,{authenticate:async(c,o)=>{delivered=await c.authflow.getMinecraftJavaToken({fetchProfile:true});o.connect(c)}})
  const connected=once(client,'connected');auth(client,{connect:()=>client.emit('connected')});await connected
  assert.equal(delivered.certificates,certificate)
  f.store.login=()=>({getMinecraftJavaToken:async()=>({...java}),mca:{fetchProfile:async()=>({...java.profile,id:'b'.repeat(32)})}})
  let attempted=false;const failed=once(client,'error');auth(client,{connect:()=>{attempted=true}})
  assert.match((await failed)[0].message,/different Minecraft player/);assert.equal(attempted,false)
 }finally{f.close()}
})
test('expired account requests relinking instead of opening a hidden device login',async()=>{
 const f=fixture();try{
  const id=f.store.begin();f.store.commit(id,java)
  f.store.login=(_,callback)=>({getMinecraftJavaToken:async()=>{callback({user_code:'DO-NOT-USE'})}})
  const client=new EventEmitter();client.end=()=>{};let attempted=false
  const auth=linkedAccountAuth(f.store,id,{authenticate:async(c,o)=>{await c.authflow.getMinecraftJavaToken({});o.connect(c)}})
  const failed=once(client,'error');auth(client,{connect:()=>{attempted=true}})
  assert.match((await failed)[0].message,/Open Agent connection/);assert.equal(attempted,false)
 }finally{f.close()}
})
test('native account CLI lists, checks and removes a saved account without exposing cached credentials',()=>{
 const f=fixture();try{
  const id=f.store.begin();f.store.commit(id,java);writeFileSync(join(f.store.directory(id),'credential-cache.json'),'private-token')
  const run=action=>{const p=spawnSync(process.execPath,[resolve('src/companion/account-tool.js')],{input:JSON.stringify({action,root:f.store.root,id,owner:'SoulTeammate'}),encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.equal(p.stderr,'');assert.ok(!p.stdout.includes('private-token'));return JSON.parse(p.stdout)}
  assert.equal(run('list').accounts[0].name,'SoulTeammate');assert.equal(run('check').account.id,id)
  assert.deepEqual(run('remove').accounts,[]);assert.equal(existsSync(f.store.directory(id)),false)
 }finally{f.close()}
})
test('world configuration retains a validated account reference and legacy profiles remain readable',()=>{
 const base={host:'localhost',port:25565,owner:'SoulTeammate',username:'legacy@example.com',auth:'microsoft',version:'1.21.4',provider:'codex',model:'gpt-6-astra'}
 assert.equal(validateSetup(base).username,base.username)
 const id='11111111-2222-3333-4444-555555555555',value=validateSetup({...base,minecraftAccountId:id})
 assert.equal(value.minecraftAccountId,id);assert.equal(value.username,id)
 assert.throws(()=>validateSetup({...base,minecraftAccountId:'../../escape'}))
 assert.equal(validateSetup({...base,auth:'offline',username:'Bot',minecraftAccountId:id}).minecraftAccountId,undefined)
})
test('account errors provide actions without leaking upstream tokens',()=>{
 assert.equal(accountFailure(new Error('secret-token')).message.includes('secret-token'),false)
 assert.equal(accountFailure(new Error('2148916238')).code,'permissions')
 assert.equal(accountFailure(new Error('code_expired')).code,'expired')
 assert.equal(accountFailure(new AccountError('wrong_account','Choose the bot.')).message,'Choose the bot.')
})
test('relinking the same Java player refreshes credentials while preserving saved world references',()=>{
 const f=fixture();try{
  const original=f.store.begin();f.store.commit(original,java)
  const fresh=f.store.begin();writeFileSync(join(f.store.directory(fresh),'abcd_live-cache.json'),'new-private-token')
  const renewed=f.store.commit(fresh,{...java,profile:{...java.profile,name:'RenamedBot'}})
  assert.equal(renewed.id,original);assert.equal(renewed.name,'RenamedBot');assert.equal(f.store.list().length,1)
  assert.equal(existsSync(f.store.directory(fresh)),false)
  assert.equal(readFileSync(join(f.store.directory(original),'abcd_live-cache.json'),'utf8'),'new-private-token')
  assert.equal(statSync(join(f.store.directory(original),'abcd_live-cache.json')).mode&0o777,0o600)
 }finally{f.close()}
})

test('profile verification keeps real HTTP failures distinct from missing ownership and hides response bodies',async()=>{
 for(const [status,code] of [[404,'java_profile'],[401,'relink'],[403,'profile_denied'],[429,'profile_rate_limit'],[503,'profile_unavailable'],[0,'profile_unavailable']]){
  const flow={getMinecraftJavaToken:async options=>{assert.equal(options.fetchProfile,false);return {...java,profile:undefined}},mca:{fetchProfile:async token=>{assert.equal(token,java.token);throw new Error(`${status} upstream secret-token private-email`)}}}
  await assert.rejects(verifiedJavaToken(flow),error=>{const publicError=accountFailure(error);assert.equal(publicError.code,code);assert.ok(!JSON.stringify(publicError).includes('secret-token'));assert.ok(!JSON.stringify(publicError).includes('private-email'));return true})
 }
})
test('strict Java profile retrieval preserves certificates and rejects malformed responses and changed identities',async()=>{
 const certificates={key:'private-key'},flow={getMinecraftJavaToken:async()=>({...java,profile:undefined,certificates}),mca:{fetchProfile:async()=>java.profile}}
 const result=await verifiedJavaToken(flow,{fetchCertificates:true},java.profile.id)
 assert.equal(result.profile.name,java.profile.name);assert.equal(result.certificates,certificates)
 flow.mca.fetchProfile=async()=>({})
 await assert.rejects(verifiedJavaToken(flow),e=>e.code==='profile_response')
 flow.mca.fetchProfile=async()=>({...java.profile,id:'b'.repeat(32)})
 await assert.rejects(verifiedJavaToken(flow,{},java.profile.id),e=>e.code==='wrong_account')
})
test('new-profile session rejection refreshes Minecraft credentials once on the existing retry',async()=>{
 const f=fixture();try{
  const id=f.store.begin();f.store.commit(id,java);const forced=[]
  f.store.login=()=>{const mca={fetchProfile:async()=>java.profile};return {mca,getMinecraftJavaToken:async()=>{forced.push(mca.forceRefresh===true);return {...java}}}}
  const auth=linkedAccountAuth(f.store,id,{authenticate:async c=>{await c.authflow.getMinecraftJavaToken({});c.emit('authenticated')}})
  async function attempt(error){const c=new EventEmitter();c.end=()=>{};c.on('error',()=>{});const ready=once(c,'authenticated');auth(c,{});await ready;if(error)c.emit('error',new Error(error))}
  await attempt('temporary connection error')
  await attempt('Profile not found, please restart your launcher if you recently created your profile')
  await attempt('Profile not found, please restart your launcher if you recently created your profile')
  await attempt()
  assert.deepEqual(forced,[false,false,true,false])
 }finally{f.close()}
})
