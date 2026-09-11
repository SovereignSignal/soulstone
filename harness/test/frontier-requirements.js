// Literal geometry and actual walkthrough evidence, independent of model goals.
export function coveredDeck(blueprint,origin,walkthrough){
 const blocks=blueprint.blocks,solid=new Set(blocks.map(b=>`${b.x},${b.y},${b.z}`))
 for(const floor of blocks)for(const [width,depth]of [[2,3],[3,2]]){
  if(floor.y+1<2)continue
  const deck=Array.from({length:width*depth},(_,i)=>({x:floor.x+i%width,y:floor.y,z:floor.z+Math.floor(i/width)}))
  if(!deck.every(p=>solid.has(`${p.x},${p.y},${p.z}`)&&[1,2].every(dy=>!solid.has(`${p.x},${p.y+dy},${p.z}`))&&blocks.some(b=>b.x===p.x&&b.z===p.z&&b.y>=p.y+3)))continue
  if(!walkthrough.some(w=>deck.some(p=>Math.floor(w.x)===origin.x+p.x&&Math.floor(w.z)===origin.z+p.z&&Math.abs(w.y-origin.y-p.y-1)<.1)))continue
  return {width,depth,floor:deck,walkingHeight:floor.y+1}
 }
 return null
}
