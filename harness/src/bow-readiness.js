// Which hostiles the bow answers, and whether it can answer one from cover. A
// leaf with no imports: the shelter code (burrow.js) and the bow (archery.js)
// both read it, and archery.js sits on the import path back into burrow.js.
export const RANGED_DEFENSE=new Set(['blaze','ghast','skeleton','stray','bogged','pillager','witch'])
// From cover: could the bow answer this hostile once a wall is open? Sightline and
// aim are judged after opening up; this is only whether opening up is worth it.
export function bowCanAnswer(bot,name,{healthFloor=10,minArrows=4}={}){
 if(!RANGED_DEFENSE.has(name))return false
 const items=bot.inventory?.items?.()||[]
 return items.some(i=>i.name==='bow')&&items.filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)>=minArrows&&Number.isFinite(bot.health)&&bot.health>=healthFloor
}
