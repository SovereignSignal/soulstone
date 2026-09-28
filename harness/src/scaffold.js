import {fullCube} from './construction.js'

const falling = new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'])
// Automatic movement must preserve portal material for explicit construction.
export const scaffoldItems = bot => bot.inventory.items().filter(i =>
  i.name !== 'obsidian' && !falling.has(i.name) && fullCube(bot.registry,i.name))
