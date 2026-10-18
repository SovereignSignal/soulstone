import {spawn} from 'node:child_process'
import {stopProcessTree} from './platform.js'
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises'
import {tmpdir,homedir} from 'node:os'
import {join} from 'node:path'
import {clientBinary,subscriptionEnv,subscriptionStatus} from './subscriptions.js'
import {validateProfile} from './providers.js'

// Metadata only: never send a user turn, prompt or inference request.
export function readCliMetadata(binary,args,kind,{cwd,timeout=15000}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{cwd,env:subscriptionEnv(),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
  let pending='',bytes=0,settled=false,models=[],nextId=2
  const stop=()=>{stopProcessTree(child);const t=setTimeout(()=>stopProcessTree(child,{signal:'SIGKILL'}),500);t.unref();child.once('close',()=>clearTimeout(t))}
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);stop();error?reject(error):resolve(result)}
  const timer=setTimeout(()=>finish(new Error('Model discovery timed out. Check provider sign-in and retry.')),timeout)
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n')
  child.stdin.on('error',()=>{})
  child.on('error',()=>finish(new Error('Could not start the provider CLI. Install it and sign in first.')))
  child.on('close',()=>{if(!settled)finish(new Error('Provider model discovery failed. Update its CLI and check sign-in.'))})
  child.stderr.on('data',b=>{bytes+=b.length;if(bytes>2000000)finish(new Error('Provider returned too much metadata.'))})
  child.stdout.on('data',b=>{
   bytes+=b.length;if(bytes>2000000){finish(new Error('Provider returned too much metadata.'));return}
   pending+=b.toString()
   while(pending.includes('\n')&&!settled){const index=pending.indexOf('\n'),line=pending.slice(0,index);pending=pending.slice(index+1)
    let value;try{value=JSON.parse(line)}catch{continue}
    if(kind==='codex'){
     if(value.error){finish(new Error('Codex could not list models. Check sign-in and update the CLI.'));return}
     if(value.id===1){send({method:'initialized',params:{}});send({method:'model/list',id:nextId,params:{limit:100,includeHidden:false}})}
     else if(value.id===nextId){
      if(!Array.isArray(value.result?.data)){finish(new Error('Codex returned an invalid model list.'));return}
      models.push(...value.result.data)
      if(value.result.nextCursor&&models.length<500){nextId++;send({method:'model/list',id:nextId,params:{limit:100,includeHidden:false,cursor:value.result.nextCursor}})}
      else finish(null,models)
     }
    }else if(value.type==='control_response'&&value.response?.request_id==='models'){
     if(value.response.subtype!=='success'){finish(new Error('Claude could not list models. Check sign-in and update the CLI.'));return}
     finish(null,value.response.response?.models)
    }
   }
  })
  if(kind==='codex')send({method:'initialize',id:1,params:{clientInfo:{name:'soulstone',title:'SoulStone',version:'0.1.0'}}})
  else send({type:'control_request',request_id:'models',request:{subtype:'initialize',hooks:{}}})
 })
}

export function modelOptions(rows,kind) {
 if(!Array.isArray(rows))throw new Error('Provider did not return a model list.')
 const seen=new Set(),result=[]
 for(const row of rows.slice(0,500)){
  if(!row||typeof row!=='object')continue
  const id=kind==='codex'?row.model:kind==='claude'?row.value:kind==='muse'?row.model_id:row.id
  if(typeof id!=='string'||!/^[a-zA-Z0-9_.:/-]{1,160}$/.test(id)||row.hidden||row.visibility==='hidden'||seen.has(id))continue
  if(kind==='codex'&&Array.isArray(row.inputModalities)&&!row.inputModalities.includes('text'))continue
  seen.add(id);result.push({id,label:String(row.displayName||row.display_label||row.name||id).slice(0,160),description:String(row.description||'').slice(0,400),isDefault:row.isDefault===true||row.is_default===true})
 }
 if(!result.length)throw new Error('No usable models were returned. Check provider access and refresh.')
 return result
}

// Muse Code caches the account's model catalog locally after sign-in. That
// cache is metadata only and needs no inference turn to read. Before the
// first sign-in refresh there may be no cache yet; the Muse models known at
// this build are the fallback so setup can still offer a choice.
export const museFallbackModels = [
 {model_id:'muse-wonder-1.0',display_label:'muse-wonder-1.0',is_default:true,visibility:'visible'},
 {model_id:'muse-wonder-full-1.0',display_label:'muse-wonder-full-1.0',visibility:'visible'},
 {model_id:'muse-spark-1.3',display_label:'muse-spark-1.3',visibility:'visible'},
]
export function museCatalogDir({env=process.env,home=homedir()}={}) {
 return join(env.XDG_DATA_HOME||join(home,'.local','share'),'muse','model-catalog')
}
export async function museCatalogRows(dir=museCatalogDir()) {
 const rows=[]
 for(const name of (await readdir(dir).catch(()=>[])).filter(n=>n.endsWith('.json')).slice(0,20)){
  try {const v=JSON.parse(await readFile(join(dir,name),'utf8'));if(Array.isArray(v.rows))rows.push(...v.rows)}catch{}
 }
 return rows
}
export async function discoverModels(value,{catalogDir,status=subscriptionStatus}={}) {
 const {kind}=value||{}
 if(kind==='muse'){
  const s=await status(kind);if(!s.ready)throw new Error(s.message)
  const rows=await museCatalogRows(catalogDir)
  return {models:modelOptions(rows.length?rows:museFallbackModels,kind),source:'Muse subscription'}
 }
 if(['codex','claude'].includes(kind)){
  const status=await subscriptionStatus(kind);if(!status.ready)throw new Error(status.message)
  const cwd=await mkdtemp(join(tmpdir(),'soulstone-models-'))
  try{
   const args=kind==='codex'?['--disable','apps','--disable','multi_agent','-c','features.skip_host_skill_discovery=true','-c','model_provider="openai"','app-server']
    :['--print','--safe-mode','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence','--input-format','stream-json','--output-format','stream-json','--verbose']
   return {models:modelOptions(await readCliMetadata(clientBinary(kind),args,kind,{cwd}),kind),source:kind==='codex'?'Codex subscription':'Claude subscription'}
  }finally{await rm(cwd,{recursive:true,force:true})}
 }
 const profile=validateProfile({id:'discovery',label:'Discovery',model:'discovery',kind,url:value?.url,maxTokens:4096})
 const key=value.apiKey||''
 if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))throw new Error('Invalid API key')
 if(kind!=='local'&&!key)throw new Error('Enter the provider API key to load its models.')
 const endpoint=new URL(profile.url);endpoint.pathname=endpoint.pathname.replace(/\/(?:chat\/completions|responses)\/?$/,'/models')
 const response=await fetch(endpoint,{headers:key?{Authorization:'Bearer '+key}:{},redirect:'error',signal:AbortSignal.timeout(10000)})
 if(!response.ok)throw new Error(`Model list returned HTTP ${response.status}. Check this provider's endpoint and access.`)
 const data=await response.json();return {models:modelOptions(data.data,kind),source:kind==='local'?'Local model server':'Provider API'}
}
