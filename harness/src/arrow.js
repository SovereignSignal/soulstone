// The bow's ballistics, kept apart from the bow skill so the sight judges (visibility.js) can ask for the bow's reach
// without the skill's imports (live rehearsal, 16 October 22:21Z: the hut's port judge now asks the bow's question).
// Bow aim for the dragon ladder: blazes keep their distance and the dragon's end
// crystals sit on towers. A fully drawn arrow leaves at 3 blocks a tick, falls
// 0.05 a tick to gravity and keeps 0.99 of its speed to drag each tick. The aim
// is the pitch whose simulated path passes through the target, low arc first.
export const ARROW={speed:3,gravity:0.05,drag:0.99,maxTicks:120}

// The path as (horizontal distance, height) points, one per tick, from the launch point.
export function arrowPath(pitch,{ticks=ARROW.maxTicks,speed=ARROW.speed}={}){
 let x=0,y=0,vx=Math.cos(pitch)*speed,vy=Math.sin(pitch)*speed
 const path=[{x,y}]
 for(let i=0;i<ticks;i++){x+=vx;y+=vy;vx*=ARROW.drag;vy=vy*ARROW.drag-ARROW.gravity;path.push({x,y})}
 return path
}
// Height of the path at horizontal distance d, and the ticks it took; null if it never gets there.
function heightAt(pitch,d){
 const path=arrowPath(pitch)
 for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i];if(b.x>=d){const t=(d-a.x)/(b.x-a.x);return {y:a.y+(b.y-a.y)*t,ticks:i-1+t}}}
 return null
}
// The low-arc pitch (radians, up positive) that lands on `to` from `from`, or null past the bow's reach.
export function aimPitch(from,to){
 const d=Math.hypot(to.x-from.x,to.z-from.z),dy=to.y-from.y
 // Height reached at d rises with pitch up to the range-maximising angle; search below it.
 let best=-Math.PI/2+0.01,bestY=-Infinity
 for(let p=-Math.PI/2+0.01;p<Math.PI/2;p+=0.01){const h=heightAt(p,d);if(h&&h.y>bestY){bestY=h.y;best=p}}
 if(bestY<dy)return null
 let lo=-Math.PI/2+0.01,hi=best
 for(let i=0;i<60;i++){const mid=(lo+hi)/2,h=heightAt(mid,d);if(h&&h.y<dy)lo=mid;else hi=mid}
 return (lo+hi)/2
}
// Lead a moving target: aim where it will be when the arrow arrives (two refinements).
aimPitch.lead=function(from,to,velocity){
 let aimAt=to.clone?.()??to,pitch=aimPitch(from,aimAt)
 for(let i=0;i<2&&pitch!==null;i++){
  const flight=heightAt(pitch,Math.hypot(aimAt.x-from.x,aimAt.z-from.z))?.ticks??0
  aimAt=to.plus(velocity.scaled(flight));pitch=aimPitch(from,aimAt)
 }
 return {aimAt,pitch}
}

