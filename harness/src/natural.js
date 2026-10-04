// Natural ground: what the bot may break when a walk or a dig step tunnels.
// In a world it shares with players (the family world, from 4 October 2026)
// it must never cut through what someone built, so the general digging walk
// and the dig action break only blocks that generate in the world: stone and
// its kin, soil, sand and gravel, ores, leaves, snow, and the Nether's and
// End's ground. Planks, logs, cobblestone, glass, wool, bricks and every other
// building block are routed around or refused, even when that costs a detour.
export const NATURAL=new Set([
 'stone','deepslate','tuff','granite','diorite','andesite','calcite','dripstone_block','basalt','smooth_basalt','blackstone',
 'dirt','grass_block','coarse_dirt','podzol','rooted_dirt','mud','clay','mycelium','moss_block',
 'sand','red_sand','gravel','sandstone','red_sandstone','terracotta','snow','snow_block','powder_snow',
 'netherrack','soul_sand','soul_soil','magma_block','end_stone','sculk','ancient_debris','amethyst_block','budding_amethyst',
])
export const isNatural=name=>!!name&&(NATURAL.has(name)||/_ore$/.test(name)||/_leaves$/.test(name)||/_terracotta$/.test(name)&&!/glazed/.test(name))
