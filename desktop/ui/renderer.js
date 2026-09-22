import {childStatus} from '../contract.js'
const api=window.soulstone,$=id=>document.getElementById(id),setup=$('setup'),form=$('setup-form')
let info=null,state=null,sessionOpen=false,muted=false,listening=false,foundWorlds=[]
const notice=(text,target='notice')=>{$(target).textContent=text;$(target).hidden=!text}
async function run(name,value,target='notice'){
 try{return await api.command(name,value)}catch(error){notice(String(error.message).replace(/^Error invoking remote method '[^']+': Error: /,''),target);return undefined}
}
function render(){
 const view=childStatus(state);$('status-title').textContent=view.title;$('status-detail').textContent=view.detail
 $('world-name').textContent=info?.profile?.name||'Your Minecraft teammate';$('connection-dot').classList.toggle('connected',!!state?.connected)
 $('talk').disabled=!view.ready||!info?.voiceReady;$('play').disabled=!info?.profile&&!sessionOpen;$('play-label').textContent=sessionOpen?'Leave':'Play'
 $('resume').hidden=!state?.canResume;$('respawn').hidden=!state?.dead
 document.querySelectorAll('[data-request]').forEach(button=>button.disabled=!view.ready)
 $('message').disabled=!view.ready;$('chat-form').querySelector('button').disabled=!view.ready
 $('inventory').textContent=Object.entries(state?.inventory||{}).map(([name,count])=>`${count} ${name.replaceAll('_',' ')}`).join(' · ')||'Nothing in my bag yet.'
 const messages=(state?.messages||[]).slice(-8)
 if(messages.length){
  const chat=$('conversation'),wasAtEnd=chat.scrollHeight-chat.scrollTop-chat.clientHeight<30
  const signature=JSON.stringify(messages);if(chat.dataset.signature!==signature){chat.dataset.signature=signature;chat.replaceChildren(...messages.map(message=>{const p=document.createElement('p');p.className='chat-message'+(message.role==='user'?' user':'');const label=document.createElement('strong');label.textContent=message.role==='user'?'You':'SoulStone';p.append(label,document.createTextNode(message.text));return p}));if(wasAtEnd)chat.scrollTop=chat.scrollHeight}
 }else{const chat=$('conversation');if(chat.dataset.signature){chat.dataset.signature='';const p=document.createElement('p');p.className='empty-chat';p.textContent='What shall we do together?';chat.replaceChildren(p)}}
}
function fields(){const values=Object.fromEntries(new FormData(form));values.port=Number(values.port);values.newWorld=form.elements.newWorld.checked;values.keepLAN=!values.newWorld;return values}
function fillAccounts(accounts){const chosen=form.elements.minecraftAccountId.value||info?.profile?.minecraftAccountId;form.elements.minecraftAccountId.replaceChildren(new Option('Choose the teammate’s account',''),...accounts.map(a=>new Option(a.name,a.id)));if(chosen)form.elements.minecraftAccountId.value=chosen}
async function refreshInfo(){const result=await run('info');if(result){info=result;sessionOpen=result.running;render()}return result}
async function showSetup(){
 await refreshInfo();if(!info)return
 const profile=info.profile||{};for(const key of ['name','host','port','owner','provider'])if(profile[key]!==undefined)form.elements[key].value=profile[key]
 form.elements.newWorld.checked=false
 $('lan-help').textContent=profile.lan?'This world is remembered. SoulStone will look for its current LAN port when she presses Play.':'Open the Java world to LAN, then find it here. SoulStone can remember it and find its new port next time.'
 if(profile.model){form.elements.model.replaceChildren(new Option(profile.model,profile.model))}
 fillAccounts(info.accounts);setup.showModal();notice(info.configError||'','setup-status')
}
$('parent').onclick=showSetup
$('close-setup').onclick=()=>{void run('cancel-link');void run('cancel-talk');setup.close()}
setup.addEventListener('cancel',()=>{void run('cancel-link');void run('cancel-talk')})
$('play').onclick=async()=>{notice('');$('play').disabled=true;const result=await run(sessionOpen?'leave':'play');if(result&&!result.cancelled){sessionOpen=!sessionOpen;state=await run('state');notice('')}render()}
$('talk').onclick=()=>run('talk')
$('stop').onclick=async()=>{const result=await run('stop');if(result)notice('Stopped. I’ll wait for you.');listening=false;$('listening').hidden=true;$('talk-label').textContent='Talk';$('talk').classList.remove('active')}
$('cancel-talk').onclick=()=>run('cancel-talk')
$('resume').onclick=()=>run('resume')
$('respawn').onclick=()=>$('respawn-dialog').showModal()
$('cancel-respawn').onclick=()=>$('respawn-dialog').close()
$('confirm-respawn').onclick=async()=>{await run('respawn');$('respawn-dialog').close()}
$('sound').onclick=async()=>{const result=await run('mute',!muted);if(result){muted=result.muted;$('sound').textContent=muted?'Sound off':'Sound on';$('sound').setAttribute('aria-pressed',String(muted))}}
document.querySelectorAll('[data-request]').forEach(button=>button.onclick=()=>run('message',button.dataset.request))
$('chat-form').onsubmit=async event=>{event.preventDefault();const result=await run('message',$('message').value);if(result)$('message').value=''}
$('models').onclick=async()=>{const provider=form.elements.provider.value;$('models').disabled=true;notice('Checking your model account…','setup-status');const result=await run('models',provider,'setup-status');$('models').disabled=false;if(result&&provider===form.elements.provider.value){form.elements.model.replaceChildren(...result.models.map(m=>new Option(m.label,m.id,false,m.isDefault)));notice('Thinking account ready. Choose a model above.','setup-status')}}
$('find-worlds').onclick=async()=>{$('find-worlds').disabled=true;notice('Listening for open Minecraft worlds…','setup-status');const worlds=await run('find-worlds',undefined,'setup-status');$('find-worlds').disabled=false;if(worlds){foundWorlds=worlds;$('found-worlds-label').hidden=false;$('found-worlds').replaceChildren(new Option('Choose a world',''),...worlds.map(world=>new Option(world.motd,world.key)));notice(worlds.length?'Choose her world above.':'No open worlds found. Open Java to LAN or enter the port manually.','setup-status')}}
$('found-worlds').onchange=()=>{const world=foundWorlds.find(world=>world.key===$('found-worlds').value);if(world){form.elements.host.value=world.host;form.elements.port.value=world.port;$('lan-help').textContent='SoulStone will look for this world’s current port each time she presses Play.'}}
form.elements.provider.onchange=()=>form.elements.model.replaceChildren(new Option('Check available models',''))
$('link').onclick=()=>run('link',undefined,'setup-status')
$('signin-open').onclick=()=>run('open-signin',undefined,'setup-status')
$('signin-cancel').onclick=()=>run('cancel-link')
$('voice-test').onclick=()=>{if(listening)void run('talk',undefined,'setup-status');else void run('voice-test',undefined,'setup-status')}
$('check').onclick=async()=>{if(!form.reportValidity())return;notice('Checking your world, account and microphone…','setup-status');const result=await run('check',fields(),'setup-status');if(result)notice(`${result.world.status==='reachable'?'World found.':result.world.message} ${result.thinking.ready?'Thinking account ready.':result.thinking.message} ${result.voiceReady?'Voice available. Try her microphone before playing.':'Voice unavailable. Check microphone and speech language settings.'}`,'setup-status')}
form.onsubmit=async event=>{event.preventDefault();const saved=await run('save',fields(),'setup-status');if(saved){await refreshInfo();setup.close();notice('All set. Open the Minecraft world and press Play.')}}
api.onEvent(({type,value})=>{
 if(type==='state'){state=value;render()}
 if(type==='notice')notice(value)
 if(type==='heard')notice(`You said: “${value}”`)
 if(type==='voice'){
  if(value.type==='ready'){if(info)info.voiceReady=value.available!==false;render()}
  if(value.type==='listening'||value.type==='transcript'){listening=true;$('listening').hidden=false;$('voice-text').textContent=value.text||'I’m listening…';$('talk-label').textContent='Send';$('talk').classList.add('active');$('voice-test').textContent='Finish voice test'}
  else{listening=false;$('listening').hidden=true;$('talk-label').textContent='Talk';$('talk').classList.remove('active');$('voice-test').textContent='Test microphone'}
  if(value.type==='tested')$('voice-result').textContent=`Heard: “${value.text}”. Check that she heard the reply too.`
  if(value.type==='error'||value.type==='retry'){notice(value.message,setup.open?'setup-status':'notice');$('voice-result').textContent=value.message}
 }
 if(type==='account'){
  if(value.type==='code'){$('signin').hidden=false;$('signin-code').textContent=value.code}
  else{$('signin').hidden=true;if(value.type==='linked'){void refreshInfo().then(()=>{fillAccounts(info.accounts);form.elements.minecraftAccountId.value=value.account.id});$('account-result').textContent=`Linked ${value.account.name}.`}else if(value.type==='error')notice(value.message,'setup-status')}
 }
})
if(!api){notice('Open SoulStone Play to use the app.');throw new Error('Desktop bridge unavailable')}
await refreshInfo()
if(!info?.profile){notice('A grown-up needs to set up your world first.');await showSetup()}
if(info?.shortcuts&&(!info.shortcuts.talk||!info.shortcuts.stop))notice('A keyboard shortcut is already in use. Use the Talk and Stop buttons, or ask a grown-up to close the other app.')
