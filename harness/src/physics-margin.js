// Paper refuses a move whose box ends exactly on a block face (its
// PlayerFailMoveEvent reason CLIPPED_INTO_BLOCK) and teleports the player back
// with its velocity zeroed; vanilla allows it. prismarine-physics resolves every
// collision to exactly flush, so on Paper the bot was sent back ~18 times a
// second while walking, lost every jump, and stalled against steps and trunks.
// Simulating the body a thousandth of a block wider keeps it just clear of the
// face. mineflayer takes the physics factory when it is first required, so this
// module must be the first import of anything that can load mineflayer first.
import { createRequire } from 'node:module'

export const HALF_WIDTH_MARGIN = 0.001

const physics = createRequire(import.meta.url)('prismarine-physics')
if (!physics.Physics.soulstoneMargin) {
  const original = physics.Physics
  physics.Physics = Object.assign((...args) => {
    const simulation = original(...args)
    simulation.playerHalfWidth += HALF_WIDTH_MARGIN
    return simulation
  }, { soulstoneMargin: HALF_WIDTH_MARGIN })
}
