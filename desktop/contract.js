// This is also the IPC boundary. The renderer cannot supply URLs, file paths,
// executable names or arbitrary service methods.
export const commands = new Set(['info','save','models','check','link','cancel-link','play','leave','state','message','stop','resume','respawn','talk','cancel-talk','voice-test','mute','open-signin','find-worlds'])
export function validateCommand(command,value) {
 if(!commands.has(command))throw new Error('Unknown app action')
 if(value!==undefined&&JSON.stringify(value).length>10000)throw new Error('App request too large')
 if(command==='message'&&(typeof value!=='string'||!value.trim()||value.length>2000))throw new Error('Say a short request first.')
 if(command==='models'&&!['codex','claude'].includes(value))throw new Error('Choose a thinking provider.')
 if(command==='mute'&&typeof value!=='boolean')throw new Error('Invalid sound setting')
 return value
}
export function childStatus(state) {
 if(!state)return {title:'Ready for an adventure?',detail:'Open your Minecraft world, then press Play.',ready:false}
 if(state.dead)return {title:'I need a fresh start',detail:'I can come back into the world. My things may be where I fell.',ready:false}
 if(!state.connected)return {title:'I can’t see your world yet',detail:'Ask a grown-up to check that your Minecraft world is open.',ready:false}
 if(!state.modelReady)return {title:'I need a little help',detail:'Ask a grown-up to check my thinking account.',ready:false}
 if(['retreating','defending'].includes(state.phase))return {title:'Finding somewhere safe',detail:'You can still tell me to stop.',ready:true}
 if(state.phase==='thinking')return {title:'Let me think…',detail:'I’m working out what to do.',ready:true}
 if(state.phase==='acting')return {title:'On it!',detail:'You can watch me in Minecraft.',ready:true}
 return {title:'Let’s play!',detail:'Tell me what you’d like to do together.',ready:true}
}
