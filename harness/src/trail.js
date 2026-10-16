// The way back is the way it came. Lab run 129 (13 October): eight seconds from
// the Nether portal the bot was a level below the fortress bridge, and the walk back,
// a route it had just walked, failed on the pathfinder's think limit; it drifted deeper
// in. A planned path can fail where a remembered one cannot: every crumb is ground the
// bot stood on, and each hop between them is short enough to plan on a Raspberry Pi.
import {dimensionOf} from './dimension.js'
import {fullCube} from './construction.js'
export const TRAIL_SPACING=2
export const TRAIL_MAX=500
// Records the ground the bot stands on, a crumb every TRAIL_SPACING blocks, since it
// arrived in its current dimension. Kept on the bot so skills can read it. Pass the
// previous connection's trail to keep it across a reconnect (lab run 122: a keepalive
// kick reconnected the bot beside the Nether portal mid-run).
export function attachTrail(bot,{spacing=TRAIL_SPACING,max=TRAIL_MAX,trail={dimension:null,crumbs:[]}}={}){
 bot.on('move',()=>{
  const p=bot.entity?.position,dimension=dimensionOf(bot)
  if(!p||!dimension)return
  if(dimension!==trail.dimension){trail.dimension=dimension;trail.crumbs=[]}
  if(!bot.entity.onGround)return
  const c=p.floored(),last=trail.crumbs.at(-1)
  if(last&&last.distanceTo(c)<spacing)return
  trail.crumbs.push(c);if(trail.crumbs.length>max)trail.crumbs.shift()
 })
 bot.trail=trail
 return trail
}
// The way back along the trail, in walking order: from the crumb nearest the bot to the
// portal end, the crumb nearest `to` (the cells beside the portal), or without `to` the
// trail's first crumb. Rehearsal, 16 October 23:12Z: the trail held a trip that went out
// to a blaze spawner and came most of the way back along the same tunnels, and the way
// back was the whole trail reversed, so the retrace walked out to the spawner first. Two
// crumbs on the same level in the same or face-adjacent cells are one place, so the trail
// is a graph, and the way back is its shortest path to the portal end: a doubled-back
// trip is cut where it crossed itself, never longer than the trail itself, and every step
// is nearer the portal along it. A crumb `usable` turns down is never walked; when that
// cuts the bot off, or no crumb lies within `reach` of `to`, it refuses with the reason.
export function wayBack(trail,from,{to=null,reach=3,usable=()=>true}={}){
 const crumbs=trail?.crumbs||[],n=crumbs.length
 if(!n)return []
 const key=c=>`${c.x},${c.y},${c.z}`,ok=crumbs.map(c=>usable(c))
 let end=-1
 if(to){
  const targets=[].concat(to),off=c=>Math.min(...targets.map(t=>c.distanceTo(t)))
  crumbs.forEach((c,i)=>{if(ok[i]&&(end<0||off(c)<off(crumbs[end])))end=i})
  if(end<0||off(crumbs[end])>reach)throw new Error(`my trail does not reach back to the portal${end<0?'':`: the nearest crumb I can stand on, ${key(crumbs[end])}, is ${Math.round(off(crumbs[end]))} blocks from it`}`)
 }else end=ok.indexOf(true)
 if(end<0)throw new Error(`my trail back to the portal is broken at ${key(crumbs[0])}: I can no longer stand there`)
 const same=(a,b)=>a.y===b.y&&Math.abs(a.x-b.x)+Math.abs(a.z-b.z)<=1
 const dist=Array(n).fill(Infinity),toward=Array(n).fill(-1),done=Array(n).fill(false)
 dist[end]=0
 for(;;){
  let u=-1
  for(let i=0;i<n;i++)if(!done[i]&&dist[i]<Infinity&&(u<0||dist[i]<dist[u]))u=i
  if(u<0)break
  done[u]=true
  for(let v=0;v<n;v++){
   if(done[v]||!ok[v]||(Math.abs(u-v)!==1&&!same(crumbs[u],crumbs[v])))continue
   const d=dist[u]+crumbs[u].distanceTo(crumbs[v])
   if(d<dist[v]){dist[v]=d;toward[v]=u}
  }
 }
 // Nearest the bot; on a tie the one with the shorter way home, then the earliest.
 let start=-1
 crumbs.forEach((c,i)=>{if(!ok[i])return;const d=c.distanceTo(from),e=start<0?Infinity:crumbs[start].distanceTo(from);if(d<e||(d===e&&dist[i]<dist[start]))start=i})
 if(dist[start]===Infinity){
  const step=start>end?-1:1;let k=start
  while(k!==end&&ok[k])k+=step
  throw new Error(`my trail back to the portal is broken at ${key(crumbs[k])}: I can no longer stand there`)
 }
 const route=[]
 for(let i=start;i>=0;i=toward[i])if(!route.length||key(route.at(-1))!==key(crumbs[i]))route.push(crumbs[i])
 return route
}
// A crumb is still ground to come back by unless its floor has fallen away (open air, or
// lava, under open feet), lava is where the feet or head go, or a full block now fills
// the head space (the bot's own plug, say; a door it walked through is not one).
// Unloaded ground is no evidence against it.
export function standingGround(bot,c){
 const [below,feet,head]=[-1,0,1].map(y=>bot.blockAt(c.offset(0,y,0)))
 if(!below||!feet||!head)return true
 if(/lava/.test(feet.name)||/lava/.test(head.name))return false
 if(fullCube(bot.registry,head.name))return false
 return feet.boundingBox!=='empty'||below.boundingBox!=='empty'
}
