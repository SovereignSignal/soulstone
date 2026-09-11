import {MinecraftAccounts,AccountError,accountFailure,verifiedJavaToken} from './minecraft-accounts.js'

// One native-owned process per sign-in. Only public identity and the short
// device code reach stdout; library diagnostics and tokens are never forwarded.
process.umask(0o077)
console.log=()=>{};console.info=()=>{};console.warn=()=>{};console.error=()=>{}
let store,pending,finished=false,timeout,parentWatch
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n')
const cleanup=()=>{if(pending){store.remove(pending);pending=null}}
const finish=(value,code=0)=>{if(finished)return;finished=true;clearTimeout(timeout);clearInterval(parentWatch);try{cleanup()}catch{};process.stdout.write(JSON.stringify(value)+'\n',()=>process.exit(code))}
process.on('SIGTERM',()=>finish({type:'cancelled'}));process.on('SIGINT',()=>finish({type:'cancelled'}))
process.stdout.on('error',()=>{try{cleanup()}catch{};process.exit(1)})
// An app exit or crash must cancel the pending login, including when a
// window's normal cancellation callback could not run.
const parentPID=process.ppid
parentWatch=setInterval(()=>{if(process.ppid!==parentPID)finish({type:'cancelled'})},1000)
try {
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>10000)throw new Error('Account request too large')}
 const value=JSON.parse(input);store=new MinecraftAccounts(value.root)
 if(value.action==='list')finish({type:'accounts',accounts:store.list()})
 else if(value.action==='remove'){store.read(value.id);store.remove(value.id);finish({type:'accounts',accounts:store.list()})}
 else if(value.action==='check'){
  const account=store.read(value.id)
  finish({type:'linked',account})
 }else if(value.action==='link'){
  pending=store.begin()
  timeout=setTimeout(()=>finish(accountFailure(new AccountError('expired','Sign-in timed out. Click Link Minecraft account to try again.')),1),15*60*1000)
  const flow=store.login(pending,code=>{
   if(!/^[A-Z0-9-]{4,20}$/i.test(code.user_code||''))throw new Error('Invalid device code')
   const seconds=Math.max(1,Math.min(900,Number(code.expires_in)||900))
   emit({type:'code',code:code.user_code,url:'https://www.microsoft.com/link',expiresAt:Date.now()+seconds*1000})
  })
  const result=await verifiedJavaToken(flow)
  if(!finished){const account=store.commit(pending,result);pending=null;finish({type:'linked',account})}
 }else throw new Error('Unknown account action')
}catch(error){finish(accountFailure(error),1)}
