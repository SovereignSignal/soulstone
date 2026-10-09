import {subscriptionKinds,requestSubscriptionPlan,PLAN_TIMEOUT_MS} from './subscriptions.js'
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
export const isLocal = url => ['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)
export function validateProfile(p) {
  if (!p || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id || '') || !['local','openai','compatible',...subscriptionKinds].includes(p.kind)) throw new Error('Invalid model profile')
  const label = String(p.label || '').trim(), model = String(p.model || '').trim()
  if (!label || label.length > 80 || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(model)) throw new Error('Enter a profile name and model ID')
  if(subscriptionKinds.includes(p.kind))return {id:p.id,kind:p.kind,label,model,url:'',maxTokens:4096}
  const url = new URL(p.url)
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint must not contain credentials or query parameters')
  if (p.kind === 'local' ? !isLocal(url) || url.protocol !== 'http:' : url.protocol !== 'https:') throw new Error('Use loopback HTTP for local models or HTTPS for cloud providers')
  if (p.kind === 'openai' && url.href !== 'https://api.openai.com/v1/responses') throw new Error('OpenAI uses https://api.openai.com/v1/responses')
  const maxTokens = Number(p.maxTokens || 4096)
  if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > 16384) throw new Error('Output limit must be 512–16384 tokens')
  return {id:p.id,kind:p.kind,label,model,url:url.href,maxTokens}
}
export class ModelProfiles {
  constructor(path, initial) {
    this.path=path;this.keys=new Map()
    try {const v=JSON.parse(readFileSync(path,'utf8'));this.profiles=v.profiles.map(validateProfile);this.active=v.active;if(!this.profiles.some(p=>p.id===this.active))throw new Error('Invalid active model')}
    catch(e){if(e.code!=='ENOENT')throw e;this.profiles=[validateProfile(initial)];this.active=initial.id}
  }
  get current(){return this.profiles.find(p=>p.id===this.active)}
  get key(){return this.keys.get(this.active)||''}
  snapshot(){return {active:this.active,profiles:this.profiles.map(p=>({...p,hasKey:this.keys.has(p.id)}))}}
  save(p,key,activate=true) {
    p=validateProfile(p)
    if (typeof key!=='string' || key.length>4096 || /[\r\n]/.test(key))throw new Error('Invalid API key')
    if(!['local',...subscriptionKinds].includes(p.kind)&&!key)throw new Error('Add this provider’s API key in Models')
    const list=this.profiles.filter(x=>x.id!==p.id);if(list.length>=20)throw new Error('Maximum 20 profiles')
    const value={active:activate?p.id:this.active,profiles:[...list,p]}
    mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(this.path+'.tmp',this.path)
    this.profiles=value.profiles;this.active=value.active
    if(key)this.keys.set(p.id,key);else this.keys.delete(p.id)
    return this.snapshot()
  }
  unlock(id,key,url){if(id!==this.active||url!==this.current.url||typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))throw new Error('Invalid credential restore');if(key)this.keys.set(id,key)}
}
export async function requestPlan(profile,key,messages,schema,signal,fetcher=fetch) {
  if(subscriptionKinds.includes(profile.kind))return requestSubscriptionPlan(profile,messages,schema,signal)
  if(profile.kind!=='local'&&!key)throw new Error('Add this provider’s API key in Models')
  const headers={'Content-Type':'application/json'}
  if(key)headers.Authorization='Bearer '+key
  const body=profile.kind==='openai' ? {model:profile.model,input:messages,store:false,max_output_tokens:profile.maxTokens,
    text:{format:{type:'json_schema',name:'teammate_plan',strict:true,schema}}}
    : {model:profile.model,messages,max_tokens:profile.maxTokens,stream:false,
      ...(profile.kind==='local'?{temperature:0.1}:{}),response_format:{type:'json_schema',json_schema:{name:'teammate_plan',strict:true,schema}}}
  // The same time to answer as the subscription planners: a local model that
  // thinks first ran past a 120 second cut on every call (pi1, 9 October).
  const response=await fetcher(profile.url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(PLAN_TIMEOUT_MS)])})
  // Never echo a provider error body: it may contain credentials or input data.
  if(!response.ok)throw new Error(`${profile.label}: HTTP ${response.status}. Check the model ID, key, account access and provider limits in Models.`)
  const data=await response.json()
  if(profile.kind==='openai') {
    if(data.status!=='completed')throw new Error('Model response was incomplete. Increase the output limit in Models or choose another model.')
    const parts=(data.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[])
    if(parts.some(x=>x.type==='refusal'))throw new Error('The selected model declined this request')
    return parts.filter(x=>x.type==='output_text').map(x=>x.text).join('')
  }
  const choice=data.choices?.[0]
  if(choice?.finish_reason==='length')throw new Error('Model response was truncated. Increase the output limit in Models.')
  if(choice?.message?.refusal)throw new Error('The selected model declined this request')
  return choice?.message?.content || ''
}
