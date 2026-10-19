import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {accessSync,statSync,constants} from 'node:fs'
import {tmpdir,homedir} from 'node:os'
import {join,isAbsolute,delimiter,win32} from 'node:path'
import {stopProcessTree} from './platform.js'
export const subscriptionKinds = ['codex','claude','muse']
function executable(path) {
 try {accessSync(path,constants.X_OK);return statSync(path).isFile()}catch{return false}
}
export function clientBinary(kind,{searchPath=process.env.PATH,canExecute=executable,platform=process.platform,home=homedir(),env=process.env}={}) {
 if(!subscriptionKinds.includes(kind))throw new Error('Choose a supported subscription client')
 if(platform==='win32') {
  const folders=[win32.join(home,'.local','bin'),env.APPDATA&&win32.join(env.APPDATA,'npm'),...(searchPath||'').split(';')].filter(x=>x&&win32.isAbsolute(x))
  const candidates=folders.flatMap(folder=>{
   const binaries=[win32.join(folder,kind+'.exe')]
   if(kind==='codex')for(const [pkg,target] of [['codex-win32-x64','x86_64-pc-windows-msvc'],['codex-win32-arm64','aarch64-pc-windows-msvc']]) {
    for(const root of [win32.join(folder,'node_modules','@openai',pkg),win32.join(folder,'node_modules','@openai','codex','node_modules','@openai',pkg),win32.join(folder,'node_modules','@openai','codex')])binaries.push(win32.join(root,'vendor',target,'codex','codex.exe'))
   }
   return binaries
  })
  const found=candidates.find(canExecute)
  if(!found)throw new Error(`Install the native ${kind} CLI, sign in, then reopen SoulStone`)
  return found
 }
 const candidates = kind==='codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex',join(homedir(),'.local/bin/codex')]
 : kind==='claude' ? [join(homedir(),'.local/bin/claude'),'/opt/homebrew/bin/claude']
 : [join(homedir(),'.local/bin/muse'),'/opt/homebrew/bin/muse']
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
 // XDG locations are paths, not credentials: Muse Code keeps its saved
 // login and model catalog under them on Linux, so the child needs them to
 // find the same login the interactive CLI uses. META_API_KEY stays out.
 return Object.fromEntries(['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','SSL_CERT_FILE','XDG_CONFIG_HOME','XDG_DATA_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','PATHEXT'].filter(k=>env[k]).map(k=>[k,env[k]]))
}
export const PLAN_TIMEOUT_MS=300000
// The structured-output endpoint requires every object in a response schema to
// declare additionalProperties:false, and rejects the whole request with a 400
// otherwise. Adding it at the boundary keeps the harness's own schemas readable
// and survives the requirement appearing on providers that did not have it.
export function strictSchema(node){
 if(Array.isArray(node))return node.map(strictSchema)
 if(!node||typeof node!=='object')return node
 const out={}
 for(const [k,v] of Object.entries(node))out[k]=strictSchema(v)
 if(out.type==='object'||out.properties)out.additionalProperties=false
 return out
}
export function runClient(binary,args,{cwd,input='',signal,timeout=120000}={}) {
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new Error('Cancelled'));return}
  const child=spawn(binary,args,{cwd,env:subscriptionEnv(),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
  let out='',err='',failed=null,killTimer
  const stop=()=>{stopProcessTree(child);killTimer=setTimeout(()=>stopProcessTree(child,{signal:'SIGKILL'}),1000);killTimer.unref()}
  // Name the cause. One message for three different failures sent a whole
  // evening's debugging at the wrong problem: a run reported "timed out" while
  // the client was in fact answering in seconds.
  const abort=reason=>{if(failed)return;failed=reason;stop()}
  const timer=setTimeout(()=>abort(`Subscription client exceeded its ${Math.round(timeout/1000)} second budget`),timeout)
  const onAbort=()=>abort('Cancelled')
  signal?.addEventListener('abort',onAbort,{once:true})
  child.stdout.on('data',b=>{out+=b;if(out.length>8000000)abort('Subscription client returned more output than the harness will read')})
  // Diagnostic chatter is not a failure. Keep the tail and let the client finish.
  child.stderr.on('data',b=>{err+=b;if(err.length>400000)err=err.slice(-200000)})
  child.stdin.on('error',()=>{});child.stdin.end(input)
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',onAbort)}
  child.on('error',()=>{cleanup();reject(new Error('Could not start the selected subscription client'))})
  child.on('close',code=>{if(failed)stopProcessTree(child,{signal:'SIGKILL'});cleanup();if(failed)reject(new Error(signal?.aborted?'Cancelled':failed));else resolve({code,out,err})})
 })
}
export function museLoginPath({env=process.env,home=homedir()}={}) {
 return join(env.XDG_CONFIG_HOME||join(home,'.config'),'muse','auth.json')
}
export function museExecArgs(model,{schemaPath,promptPath}={}) {
 // One headless planning call: the empty preset carries no workspace tools,
 // shell and writes are off as a second line, the prompt travels as a file
 // (the capability brief outgrows comfortable argv), and the output schema
 // shapes the final answer on stdout. No session log is persisted.
 return ['exec','--provider','meta','--preset','empty','--model',model,'--output-schema',schemaPath,'--prompt-file',promptPath,'--no-session-log','--disable-shell','--disable-write','--disable-web-tools','--disable-reminders','--disable-request-user-input','--no-foreign-personal-context','--approval-mode','never','--max-model-steps','1']
}
export async function subscriptionStatus(kind) {
 try {
  if(kind==='muse') {
   // Muse Code has no status subcommand. A non-empty saved login plus an
   // installed CLI is the preflight; a stale login fails the planning call
   // itself, which reports it without any API fallback.
   clientBinary(kind)
   try {return {ready:statSync(museLoginPath()).size>2,message:'Sign in to Muse Code with muse login'}}catch{return {ready:false,message:'Sign in to Muse Code with muse login'}}
  }
  const r=await runClient(clientBinary(kind),kind==='codex'?['login','status']:['auth','status'],{cwd:tmpdir(),timeout:10000})
  if(kind==='codex')return {ready:r.code===0&&/Logged in using ChatGPT/.test(r.out+r.err),message:'Sign in to Codex with ChatGPT'}
  const a=JSON.parse(r.out);return {ready:a.loggedIn===true&&a.authMethod==='claude.ai',message:'Sign in to Claude Code with your Claude subscription'}
 } catch{return {ready:false,message:`The ${kind} subscription client is unavailable`}}
}
// One message for every failure blamed the login for a whole night of rate
// limiting (19 October: both rehearsal bots stopped planning and every receipt
// said "Check CLI login" while direct probes logged in fine). Name the kind of
// failure from the client's own words, but never echo them: client output can
// carry paths and tokens, and the reason lands in player-visible messages.
export function planFailureReason(code,out='',err='') {
 const text=`${err}\n${out}`
 if(/\b429\b|rate.?limit|too many requests|quota|usage limit|weekly limit|hit your .*limit/i.test(text))return 'it reported a subscription or rate limit; wait for the limit to reset'
 if(/\b401\b|unauthori[sz]ed|not logged in|please (log|sign) in|run \w+ login|login (expired|required)/i.test(text))return 'it reported a login problem; sign in to the CLI again'
 if(/model[^\n]{0,40}(not found|unavailable|no access|does not exist)|\b404\b/i.test(text))return 'it reported the model is unavailable; check model access'
 return `the client exited with code ${code}`
}
export async function requestSubscriptionPlan(profile,messages,schema,signal) {
 const status=await subscriptionStatus(profile.kind)
 if(!status.ready)throw new Error(status.message+'. API-key fallback is disabled.')
 const dir=await mkdtemp(join(tmpdir(),'minecraft-planner-'))
 try {
  const prompt='Return only the requested Minecraft JSON matching the provided schema. Do not use tools, inspect files, or modify the computer. The Minecraft harness executes validated steps.\n'+messages.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  let args
  if(profile.kind==='codex') {
   await writeFile(join(dir,'schema.json'),JSON.stringify(strictSchema(schema)),{mode:0o600})
   args=['exec','--ignore-user-config','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--disable','shell_tool','--disable','apps','--disable','multi_agent','-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','features.skip_host_skill_discovery=true','-c','model_provider="openai"','-c','forced_login_method="chatgpt"','--model',profile.model,'--output-schema',join(dir,'schema.json'),'--output-last-message',join(dir,'result.json'),'--color','never','-']
  } else if(profile.kind==='muse') {
   await writeFile(join(dir,'schema.json'),JSON.stringify(strictSchema(schema)),{mode:0o600})
   await writeFile(join(dir,'prompt.txt'),prompt,{mode:0o600})
   args=museExecArgs(profile.model,{schemaPath:join(dir,'schema.json'),promptPath:join(dir,'prompt.txt')})
  } else {
   args=['--print','--safe-mode','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(schema),'--model',profile.model,'--permission-mode','dontAsk','--permission-prompts','none']
  }
  // One planning call carries the whole capability brief and a JSON schema, and
  // the brief has grown as the harness gained skills. The generic two-minute
  // client budget blanked a run outright: the request reported "Subscription
  // client timed out" at round zero and the agent stood still for an hour.
  const r=await runClient(clientBinary(profile.kind),args,{cwd:dir,input:prompt,signal,timeout:PLAN_TIMEOUT_MS})
  if(r.code!==0)throw new Error(`${profile.label} could not complete the request: ${planFailureReason(r.code,r.out,r.err)}. No API fallback was attempted.`)
  if(profile.kind==='codex')return await readFile(join(dir,'result.json'),'utf8')
  if(profile.kind==='muse') {
   // With --output-schema the final answer on stdout is the JSON itself.
   // Require it to parse here so a diagnostic line can never be executed
   // downstream as a plan.
   const out=r.out.trim();JSON.parse(out);return out
  }
  const result=JSON.parse(r.out)
  if(result.is_error)throw new Error('Claude Code could not complete the request; check subscription limits')
  if(result.structured_output)return JSON.stringify(result.structured_output)
  return result.result || ''
 } finally {await rm(dir,{recursive:true,force:true})}
}
