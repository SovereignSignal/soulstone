// Who the teammate takes requests from in game chat. The admin picks one of
// three modes: the owner alone, a named list, or anyone on the server. Names
// are not secure identities on a public server, so `anyone` and a list are for
// servers whose players the admin trusts. Chat never supplies code or server
// commands either way: a request only ever becomes a validated plan.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
export const LISTEN_MODES=['owner','list','anyone']
const NAME=/^[A-Za-z0-9_]{1,16}$/
export function validateListeners(value={}){
 const mode=value.mode??'owner'
 if(!LISTEN_MODES.includes(mode))throw new Error(`Listening mode must be one of: ${LISTEN_MODES.join(', ')}`)
 const raw=value.players??[]
 if(!Array.isArray(raw)||raw.length>32)throw new Error('Players must be a list of at most 32 Minecraft names')
 const players=[]
 for(const p of raw){
  if(typeof p!=='string'||!NAME.test(p))throw new Error(`Not a Minecraft player name: ${String(p).slice(0,24)}`)
  if(!players.some(q=>q.toLowerCase()===p.toLowerCase()))players.push(p)
 }
 if(mode==='list'&&!players.length)throw new Error('A named list needs at least one player')
 // Who reads the bot's game chat, in the admin's words ("kids aged 7, 10
 // and 15"). The planner writes its chat replies for them.
 const audience=value.audience==null?'':String(value.audience).replace(/\s+/g,' ').trim()
 if(audience.length>120)throw new Error('Audience is at most 120 characters')
 return {mode,players,...(audience?{audience}:{})}
}
export function allows(config,name,owner=''){
 const who=String(name||'').toLowerCase()
 if(!who)return false
 if(config.mode==='anyone')return true
 if(config.mode==='list')return config.players.some(p=>p.toLowerCase()===who)
 return !!owner&&owner.toLowerCase()===who
}
export class Listeners {
 constructor(path,initial){
  this.path=path
  let saved=null
  try{saved=JSON.parse(readFileSync(path,'utf8'))}catch{}
  this.current=validateListeners(saved||initial||{})
 }
 snapshot(){return {mode:this.current.mode,players:[...this.current.players],audience:this.current.audience||'',modes:LISTEN_MODES}}
 allows(name,owner){return allows(this.current,name,owner)}
 save(value){
  this.current=validateListeners(value)
  mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify(this.current,null,1),{mode:0o600})
  return this.snapshot()
 }
}
