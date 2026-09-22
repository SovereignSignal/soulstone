import dgram from 'node:dgram'
import {isIP} from 'node:net'

export function parseAnnouncement(packet,address){
 if(!Buffer.isBuffer(packet)||packet.length>2048||isIP(address)!==4)return null
 const match=/^\[MOTD\]([^\x00-\x1f]{1,160})\[\/MOTD\]\[AD\]([0-9]{1,5})\[\/AD\]$/.exec(packet.toString('utf8'))
 if(!match)return null
 const port=Number(match[2]);if(port<1||port>65535)return null
 return {host:address,port,motd:match[1],key:JSON.stringify([address,match[1]])}
}
export function matchingWorld(worlds,saved){
 if(!saved||typeof saved.host!=='string'||typeof saved.motd!=='string')throw new Error('Choose the LAN world again in Grown-up setup.')
 const matches=worlds.filter(world=>world.host===saved.host&&world.motd===saved.motd)
 if(matches.length!==1)throw new Error(matches.length?'More than one matching world is open. Ask a grown-up to choose.':'Open your Minecraft world to LAN, then press Play again.')
 return matches[0]
}
// Java broadcasts its open LAN world every few seconds. Listen for one bounded
// window; never probe hosts, scan ports, or silently switch to another world.
export function discoverLAN({duration=6000,makeSocket=()=>dgram.createSocket({type:'udp4',reuseAddr:true})}={}){
 return new Promise((resolve,reject)=>{
  const socket=makeSocket(),worlds=new Map();let settled=false
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);try{socket.close()}catch{};error?reject(error):resolve([...worlds.values()])}
  const timer=setTimeout(()=>finish(),duration)
  socket.on('error',()=>finish(new Error('Could not find LAN worlds. A grown-up can enter the port instead.')))
  socket.on('message',(packet,remote)=>{const world=parseAnnouncement(packet,remote.address);if(world&&worlds.size<32)worlds.set(world.host+':'+world.port,world)})
  socket.bind(4445,()=>{try{socket.addMembership('224.0.2.60')}catch{finish(new Error('LAN discovery is unavailable. A grown-up can enter the port instead.'))}})
 })
}
