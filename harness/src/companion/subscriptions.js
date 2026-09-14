import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {accessSync,statSync,constants} from 'node:fs'
import {tmpdir,homedir} from 'node:os'
import {join,isAbsolute,delimiter} from 'node:path'
export const subscriptionKinds = ['codex','claude']
function executable(path) {
 try {accessSync(path,constants.X_OK);return statSync(path).isFile()}catch{return false}
}
export function clientBinary(kind,{searchPath=process.env.PATH,canExecute=executable}={}) {
 if(!subscriptionKinds.includes(kind))throw new Error('Choose a supported subscription client')
 const candidates = kind==='codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex',join(homedir(),'.local/bin/codex')]
 : [join(homedir(),'.local/bin/claude'),'/opt/homebrew/bin/claude']
 candidates.push(`/opt/homebrew/bin/${kind}`,`/usr/local/bin/${kind}`)
 // Finder may omit shell PATH entries; standard install paths remain available.
 // Never search the current directory through empty or relative PATH entries.
 for(const folder of (searchPath||'').split(delimiter).filter(isAbsolute))candidates.push(join(folder,kind))
 const found=candidates.find(canExecute)
 if(!found)throw new Error(`Install the ${kind} CLI first, then reopen SoulStone`)
 return found
}
export function subscriptionEnv(env=process.env) {
 // Never inherit API keys, provider overrides, current Codex task context or
 // third-party billing credentials. The official CLI owns its saved login.
 return Object.fromEntries(['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','SSL_CERT_FILE'].filter(k=>env[k]).map(k=>[k,env[k]]))
}
export const PLAN_TIMEOUT_MS=300000
export function runClient(binary,args,{cwd,input='',signal,timeout=120000}={}) {
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new Error('Cancelled'));return}
  const child=spawn(binary,args,{cwd,env:subscriptionEnv(),stdio:['pipe','pipe','pipe'],detached:true})
  let out='',err='',failed=false,killTimer
  const stop=()=>{try{process.kill(-child.pid,'SIGTERM')}catch{};killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},1000);killTimer.unref()}
  const abort=()=>{if(failed)return;failed=true;stop()}
  const timer=setTimeout(abort,timeout);signal?.addEventListener('abort',abort,{once:true})
  child.stdout.on('data',b=>{out+=b;if(out.length>2000000)abort()});child.stderr.on('data',b=>{err+=b;if(err.length>1000000)abort()})
  child.stdin.on('error',()=>{});child.stdin.end(input)
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort)}
  child.on('error',()=>{cleanup();reject(new Error('Could not start the selected subscription client'))})
  child.on('close',code=>{if(failed){try{process.kill(-child.pid,'SIGKILL')}catch{}}cleanup();if(failed)reject(new Error(signal?.aborted?'Cancelled':'Subscription client timed out'));else resolve({code,out,err})})
 })
}
export async function subscriptionStatus(kind) {
 try {
  const r=await runClient(clientBinary(kind),kind==='codex'?['login','status']:['auth','status'],{cwd:tmpdir(),timeout:10000})
  if(kind==='codex')return {ready:r.code===0&&/Logged in using ChatGPT/.test(r.out+r.err),message:'Sign in to Codex with ChatGPT'}
  const a=JSON.parse(r.out);return {ready:a.loggedIn===true&&a.authMethod==='claude.ai',message:'Sign in to Claude Code with your Claude subscription'}
 } catch{return {ready:false,message:`The ${kind} subscription client is unavailable`}}
}
export async function requestSubscriptionPlan(profile,messages,schema,signal) {
 const status=await subscriptionStatus(profile.kind)
 if(!status.ready)throw new Error(status.message+'. API-key fallback is disabled.')
 const dir=await mkdtemp(join(tmpdir(),'minecraft-planner-'))
 try {
  const prompt='Return only the requested Minecraft JSON matching the provided schema. Do not use tools, inspect files, or modify the computer. The Minecraft harness executes validated steps.\n'+messages.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  let args
  if(profile.kind==='codex') {
   await writeFile(join(dir,'schema.json'),JSON.stringify(schema),{mode:0o600})
   args=['exec','--ignore-user-config','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--disable','shell_tool','--disable','apps','--disable','multi_agent','-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','features.skip_host_skill_discovery=true','-c','model_provider="openai"','-c','forced_login_method="chatgpt"','--model',profile.model,'--output-schema',join(dir,'schema.json'),'--output-last-message',join(dir,'result.json'),'--color','never','-']
  } else {
   args=['--print','--safe-mode','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(schema),'--model',profile.model,'--permission-mode','dontAsk','--permission-prompts','none']
  }
  // One planning call carries the whole capability brief and a JSON schema, and
  // the brief has grown as the harness gained skills. The generic two-minute
  // client budget blanked a run outright: the request reported "Subscription
  // client timed out" at round zero and the agent stood still for an hour.
  const r=await runClient(clientBinary(profile.kind),args,{cwd:dir,input:prompt,signal,timeout:PLAN_TIMEOUT_MS})
  if(r.code!==0)throw new Error(`${profile.label} could not complete the request. Check CLI login, model access and subscription limits. No API fallback was attempted.`)
  if(profile.kind==='codex')return await readFile(join(dir,'result.json'),'utf8')
  const result=JSON.parse(r.out)
  if(result.is_error)throw new Error('Claude Code could not complete the request; check subscription limits')
  if(result.structured_output)return JSON.stringify(result.structured_output)
  return result.result || ''
 } finally {await rm(dir,{recursive:true,force:true})}
}
