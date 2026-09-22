import {app,BrowserWindow,ipcMain,globalShortcut,session,shell,utilityProcess,Menu} from 'electron'
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {validateCommand} from './contract.js'
import {CompanionService} from './service.js'
import {Voice} from './voice.js'
import {CommandChannel} from './command-channel.js'
import {discoverLAN,matchingWorld} from './lan.js'

const here=dirname(fileURLToPath(import.meta.url))
const resources=app.isPackaged?join(process.resourcesPath,'runtime'):join(here,'resources')
const harness=app.isPackaged?join(resources,'harness'):join(here,'../harness')
const moduleAt=name=>import(pathToFileURL(join(harness,'src/companion',name)))
if(!app.requestSingleInstanceLock())app.quit()
// Electron waits for the ESM entry module before emitting ready. Awaiting the
// entire app here would deadlock the first launch before a window exists.
else void startApp().catch(error=>{console.error('SoulStone startup failed:',error.message);app.quit()})

async function startApp(){
 await app.whenReady();Menu.setApplicationMenu(null)
 const root=app.getPath('userData');mkdirSync(root,{recursive:true,mode:0o700})
 const file=join(root,'family-setup.json')
 const [{validateSetup},{MinecraftAccounts},{subscriptionEnv,subscriptionStatus},{discoverModels},{checkConnection},{stopProcessTree}]=await Promise.all(['setup.js','minecraft-accounts.js','subscriptions.js','model-discovery.js','connection-check.js','platform.js'].map(moduleAt))
 let profile=null,configError=null,accountWorker=null,closing=false,polling=false,voiceTest=false,lastState=null,muted=false,stopOnReady=false,foundWorlds=[],joining=false
 try{if(existsSync(file))profile=JSON.parse(readFileSync(file,'utf8'))}catch{configError='Saved setup could not be read. Ask a grown-up to repair it.'}
 const environment={...subscriptionEnv(),...Object.fromEntries(['JAVA_HOME','MC_JAVA_HOME','ProgramFiles(x86)'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))}
 const service=new CompanionService({fork:(...args)=>utilityProcess.fork(...args),harness,root,environment,killTree:stopProcessTree})
 const accounts=new MinecraftAccounts(join(root,'accounts'))
 const voice=new Voice(join(resources,'voice',process.platform==='win32'?'SoulStoneVoice.exe':'SoulStoneVoice'))
 const win=new BrowserWindow({width:1000,height:780,minWidth:720,minHeight:620,title:'SoulStone Play',backgroundColor:'#101c19',webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}})
 const uiURL=pathToFileURL(join(here,'ui/index.html')).href
 const emit=(type,value)=>{if(!win.isDestroyed())win.webContents.send('soulstone:event',{type,value})}
 const authorized=event=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===uiURL
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
 win.webContents.on('will-navigate',event=>event.preventDefault())
 session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false))
 session.defaultSession.setPermissionCheckHandler(()=>false)
 const seen=new Set()
 async function cancelLink(){
  const worker=accountWorker;if(!worker)return {ok:true}
  let timer
  await new Promise(resolve=>{worker.once('exit',resolve);worker.postMessage('cancel');timer=setTimeout(()=>{worker.kill();resolve()},2000)})
  clearTimeout(timer);if(accountWorker===worker)accountWorker=null;return {ok:true}
 }
 const channel=new CommandChannel((path,payload)=>service.request(path,payload))
 const sendCommand=(...args)=>channel.send(...args)
 async function poll(){
  if(polling||closing)return
  if(!service.url){if(lastState){lastState=null;seen.clear();emit('state',null)}return}
  polling=true
  try{
   const state=await service.request('/state')
   const initial=lastState===null
   for(const message of state.messages||[]){
    if(!initial&&!seen.has(message.id)&&message.role==='assistant'&&!muted)voice.speak(message.text)
    seen.add(message.id)
   }
   lastState=state;emit('state',state)
  }catch{lastState=null;emit('state',null);emit('notice','I lost touch with your world. Ask a grown-up to check the connection.')}
  finally{polling=false}
 }
 async function talk(){
  const sequence=channel.sequence
  if(!voiceTest){const state=await service.request('/state');if(!state.connected||!state.modelReady||state.dead)throw new Error('I’m not ready to play yet. Ask a grown-up for help.')}
  if(!channel.current(sequence))return
  voice.talk()
 }
 voice.on('event',event=>emit('voice',event))
 voice.on('text',text=>{
  emit('heard',text)
  if(voiceTest){voiceTest=false;voice.speak('I heard you. We’re ready to talk!');emit('voice',{type:'tested',text});return}
  void sendCommand('/message',{text}).catch(error=>emit('notice',error.message))
 })
 const actions={
  info:()=>({profile,accounts:accounts.list(),running:!!service.child,voiceReady:voice.ready,configError,platform:process.platform,shortcuts:shortcutStatus}),
  'find-worlds':async()=>{foundWorlds=await discoverLAN();return foundWorlds},
  save:async value=>{
   if(service.child||joining)throw new Error('Leave the world before changing setup.')
   const id=value?.newWorld===true||!profile?.id?randomUUID():profile.id
   const clean=validateSetup({...value,id,auth:'microsoft',version:'auto'})
   const account=accounts.read(clean.minecraftAccountId)
   if(account.name.toLowerCase()===clean.owner.toLowerCase())throw new Error('Choose a different Minecraft account for the teammate so you can play together.')
   const selected=foundWorlds.find(world=>world.key===value.lanKey)
   const lan=selected&&selected.host===clean.host&&selected.port===clean.port?{host:selected.host,motd:selected.motd}:value.keepLAN===true&&profile?.lan&&profile.host===clean.host&&profile.port===clean.port?profile.lan:null
   const saved={...clean,name:String(value.name||'My world').trim().slice(0,80),...(lan?{lan}:{})}
   writeFileSync(file+'.pending',JSON.stringify(saved,null,2),{mode:0o600});renameSync(file+'.pending',file);profile=saved;configError=null;return saved
  },
  models:provider=>discoverModels({kind:provider}),
  check:async value=>{
   const clean=validateSetup({...value,id:profile?.id||randomUUID(),auth:'microsoft',version:'auto'})
   const [world,thinking]=await Promise.all([checkConnection(clean),subscriptionStatus(clean.provider)])
   return {world,thinking,voiceReady:voice.ready}
  },
  link:()=>{
   if(accountWorker)throw new Error('A Minecraft sign-in is already open.')
   accountWorker=utilityProcess.fork(join(here,'account-worker.js'),[],{stdio:'ignore',env:{...subscriptionEnv(),SOULSTONE_HARNESS:harness,SOULSTONE_ACCOUNTS:join(root,'accounts')},serviceName:'SoulStone account linking'})
   const worker=accountWorker;worker.on('message',value=>emit('account',value));worker.on('exit',()=>{if(accountWorker===worker)accountWorker=null});worker.postMessage('link');return {ok:true}
  },
  'cancel-link':cancelLink,
  'open-signin':async()=>{if(!accountWorker)throw new Error('Start linking first.');await shell.openExternal('https://www.microsoft.com/link')},
  play:async()=>{
   if(joining||service.child)throw new Error('A play session is already open.')
   if(!profile)throw new Error('Ask a grown-up to set up your world first.')
   if(!voice.ready)throw new Error('Ask a grown-up to check voice setup first.')
   joining=true;voiceTest=false;voice.cancel();stopOnReady=false
   try{
    let connection=profile
    if(profile.lan){emit('notice','Looking for your open Minecraft world…');const world=matchingWorld(await discoverLAN(),profile.lan);connection={...profile,host:world.host,port:world.port}}
    if(stopOnReady)return {cancelled:true}
    await service.start(validateSetup(connection));if(stopOnReady)await sendCommand('/stop');await poll();return {ok:true}
   }finally{joining=false}
  },
  leave:async()=>{channel.advance();voiceTest=false;voice.cancel();await service.shutdown();lastState=null;seen.clear();emit('state',null);return {ok:true}},
  state:()=>lastState,
  message:async text=>{const sequence=channel.advance();voiceTest=false;voice.cancel();const state=await service.request('/state');if(!channel.current(sequence))return {superseded:true};if(!state.connected||!state.modelReady||state.dead)throw new Error('I’m not ready to play yet.');return sendCommand('/message',{text},sequence)},
  stop:async()=>{const sequence=channel.advance();stopOnReady=true;voiceTest=false;voice.cancel();if(!service.url)return {ok:true};return sendCommand('/stop',{},sequence)},
  resume:()=>sendCommand('/resume'),
  respawn:()=>sendCommand('/respawn'),
  talk,
  'cancel-talk':()=>{voiceTest=false;voice.cancel();emit('voice',{type:'cancelled'})},
  'voice-test':()=>{if(service.child)throw new Error('Leave the world before testing the microphone.');voiceTest=true;voice.talk()},
  mute:value=>{muted=value;if(value)voice.cancel();return {muted}}
 }
 ipcMain.handle('soulstone:command',async(event,command,value)=>{
  if(!authorized(event))throw new Error('Unknown window')
  validateCommand(command,value);return actions[command](value)
 })
 const shortcutStatus={talk:globalShortcut.register('F8',()=>{void talk().catch(error=>emit('notice',error.message))}),stop:globalShortcut.register('F9',()=>{void actions.stop().catch(error=>emit('notice',error.message))})}
 await win.loadFile(join(here,'ui/index.html'));voice.start()
 const timer=setInterval(poll,1000)
 app.on('second-instance',()=>{if(win.isMinimized())win.restore();win.show();win.focus()})
 app.on('before-quit',event=>{
  if(closing)return
  event.preventDefault();closing=true;clearInterval(timer);globalShortcut.unregisterAll();voice.close()
  void Promise.allSettled([service.shutdown(),cancelLink()]).finally(()=>app.quit())
 })
 app.on('window-all-closed',()=>app.quit())
}
