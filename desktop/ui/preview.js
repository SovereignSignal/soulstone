// Browser-only interaction preview. Never packaged; never connects to an account or world.
const listeners=new Set()
let state=null,recording=false
let profile={id:'00000000-0000-4000-8000-000000000001',name:'Our little world',host:'localhost',port:25565,owner:'Player',provider:'codex',model:'preview-model',minecraftAccountId:'00000000-0000-4000-8000-000000000002'}
const emit=(type,value)=>listeners.forEach(fn=>fn({type,value}))
window.soulstone={
 onEvent:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},
 command:async(name,value)=>{
  if(name==='info')return {profile,accounts:[{id:profile.minecraftAccountId,name:'Teammate'}],running:!!state,voiceReady:true,shortcuts:{talk:true,stop:true}}
  if(name==='play'){state={connected:true,modelReady:true,phase:'ready',inventory:{oak_log:4,apple:2},messages:[{id:'hello',role:'assistant',text:'Hi! What would you like to do together?'}]};emit('state',state);return {ok:true}}
  if(name==='state')return state
  if(name==='leave'){state=null;emit('state',null);return {ok:true}}
  if(name==='message'){if(!state)throw new Error('Press Play first.');state.messages.push({id:crypto.randomUUID(),role:'user',text:value},{id:crypto.randomUUID(),role:'assistant',text:'This is a preview. In the app, I’ll try that in your Minecraft world.'});emit('state',state);return {ok:true}}
  if(name==='stop'){recording=false;emit('voice',{type:'cancelled'});return {ok:true}}
  if(name==='talk'||name==='voice-test'){recording=!recording;emit('voice',recording?{type:'listening'}:{type:'tested',text:'This is a microphone preview.'});return {ok:true}}
  if(name==='cancel-talk'){recording=false;emit('voice',{type:'cancelled'});return {ok:true}}
  if(name==='models')return {models:[{id:'preview-model',label:'Preview model',isDefault:true}]}
  if(name==='check')return {world:{status:'reachable'},thinking:{ready:true},voiceReady:true}
  if(name==='save'){profile={...profile,...value};return profile}
  if(name==='mute')return {muted:value}
  throw new Error('This action needs the desktop app. No account or game is connected in this preview.')
 }
}
document.getElementById('preview-label').hidden=false
