// minecraft-data 3.116's 1.21.4 blocks give 93 pickaxe blocks (iron, gold, lapis
// and diamond ores, obsidian, the metal blocks) a tool-tier tag,
// incorrect_for_wooden_tool, as their material. That material carries no tool
// speeds, so prismarine-block times every dig of them at hand speed and
// mineflayer waits that long before telling the server it finished: obsidian
// with a diamond pickaxe took 75 s instead of 9.4, iron ore with a stone pickaxe
// 4.5 s instead of 1.15, and `dig` refused obsidian as a job over 20 seconds.
//
// Point each such block at mineable/pickaxe when every tool that can harvest it
// is a pickaxe, which is what the game does. Which tools can harvest is left
// untouched. Remove when minecraft-data gives these blocks mineable/pickaxe.
export function correctToolTierMaterials(registry){
 if(!registry?.materials?.['mineable/pickaxe'])return 0
 let fixed=0
 for(const block of registry.blocksArray||[]){
  if(!/^incorrect_for_[a-z]+_tool$/.test(block.material||''))continue
  const tools=Object.keys(block.harvestTools||{}).map(id=>registry.items[id]?.name||'')
  if(!tools.length||!tools.every(name=>name.endsWith('_pickaxe')))continue
  block.material='mineable/pickaxe';fixed++
 }
 return fixed
}
