import {pathToFileURL} from 'node:url'
import {join} from 'node:path'
const {MinecraftAccounts,verifiedJavaToken,accountFailure}=await import(pathToFileURL(join(process.env.SOULSTONE_HARNESS,'src/companion/minecraft-accounts.js')))
const store=new MinecraftAccounts(process.env.SOULSTONE_ACCOUNTS)
let pending=null,finished=false,timer
const send=value=>process.parentPort.postMessage(value)
function finish(value){if(finished)return;finished=true;clearTimeout(timer);if(pending){store.remove(pending);pending=null}send(value);setTimeout(()=>process.exit(0),50)}
process.parentPort.on('message',async({data})=>{
 if(data==='cancel'){finish({type:'cancelled'});return}
 if(data!=='link'||pending||finished)return
 try{
  pending=store.begin();timer=setTimeout(()=>finish({type:'error',message:'Sign-in expired. Try linking again.'}),900000)
  const flow=store.login(pending,code=>{
   if(!/^[A-Z0-9-]{4,20}$/i.test(code.user_code||''))throw new Error('Invalid sign-in code')
   send({type:'code',code:code.user_code})
  })
  const result=await verifiedJavaToken(flow)
  if(finished)return
  const account=store.commit(pending,result);pending=null;finish({type:'linked',account})
 }catch(error){finish(accountFailure(error))}
})
process.parentPort.on('close',()=>finish({type:'cancelled'}))
process.on('SIGTERM',()=>finish({type:'cancelled'}))
