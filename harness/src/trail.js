// The way back is the way it came. Lab run 129 (13 October): eight seconds from
// the Nether portal the bot was a level below the fortress bridge, and the walk back,
// a route it had just walked, failed on the pathfinder's think limit; it drifted deeper
// in. A planned path can fail where a remembered one cannot: every crumb is ground the
// bot stood on, and each hop between them is short enough to plan on a Raspberry Pi.
import {dimensionOf} from './dimension.js'
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
// The crumbs from the one nearest the bot back to where the trail began, in walking
// order. Nearest, earliest on a tie, so a loop the bot walked is not walked again.
export function wayBack(trail,from){
 const crumbs=trail?.crumbs||[]
 if(!crumbs.length)return []
 let best=0,bestDistance=Infinity
 crumbs.forEach((c,i)=>{const d=c.distanceTo(from);if(d<bestDistance){bestDistance=d;best=i}})
 return crumbs.slice(0,best+1).reverse()
}
