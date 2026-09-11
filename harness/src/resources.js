// Resource allowlist shared by planning, task validation and world execution.
export const LOG_ITEMS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'].map(n => n + '_log')
export const isLog = name => LOG_ITEMS.includes(name)
export const validResource = name => name === 'logs' || isLog(name)
export const resourceNames = name => name === 'logs' ? LOG_ITEMS : [name]
export const resourceCount = (inventory, name) => resourceNames(name).reduce((n, item) => n + (inventory[item] || 0), 0)
export const resourceLabel = name => name === 'logs' ? 'logs' : name.replaceAll('_', ' ') + 's'

// Test distinct trunk columns instead of spending the entire retry budget on
// stacked remnants of one harvested tree. Prefer loaded, naturally rooted trunks.
const TREE_GROUND=new Set(['grass_block','dirt','podzol','coarse_dirt','rooted_dirt','mud','muddy_mangrove_roots','moss_block','mycelium','sand','gravel'])
export function gatherCandidates(bot,positions,{skipped=new Set(),skippedColumns=new Set()}={}) {
 const columns=new Map(),origin=bot.entity?.position
 for(const p of positions){
  const key=`${p.x},${p.z}`
  if(skipped.has(p.toString())||skippedColumns.has(key))continue
  const block=bot.blockAt(p);if(!block||!isLog(block.name))continue
  const old=columns.get(key);if(!old||p.y<old.position.y)columns.set(key,block)
 }
 const score=block=>{
  const p=block.position,below=bot.blockAt(p.offset(0,-1,0)),grounded=TREE_GROUND.has(below?.name)
  return (grounded?0:100000)+(origin?Math.max(0,p.y-origin.y-3)*1000+p.distanceSquared(origin):0)
 }
 return [...columns.values()].sort((a,b)=>score(a)-score(b))
}
