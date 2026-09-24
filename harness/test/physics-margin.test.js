import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { HALF_WIDTH_MARGIN } from '../src/physics-margin.js'

const require = createRequire(import.meta.url)

// Paper refuses a move whose box ends exactly on a block face, as
// CLIPPED_INTO_BLOCK, and teleports the player back with its velocity zeroed;
// vanilla allows it. prismarine-physics resolves every collision to exactly
// flush, so on Paper the bot was sent back ~18 times a second while walking,
// could not complete a jump, and stalled against every step and trunk. A
// disposable Paper lab showed 293 of 293 rejections CLIPPED_INTO_BLOCK
// walking into a wall, and none with the body simulated a thousandth wider.
test('the simulated body is a hair wider than the server box', () => {
  const { Physics } = require('prismarine-physics')
  const physics = Physics(require('prismarine-registry')('1.21.4'), { getBlock: () => null })
  assert.equal(physics.playerHalfWidth, 0.3 + HALF_WIDTH_MARGIN)
  assert.ok(HALF_WIDTH_MARGIN > 0 && HALF_WIDTH_MARGIN < 0.01, 'small enough to fit every gap a player fits')
})

test('the margin loads before anything loads mineflayer', () => {
  // mineflayer takes the physics factory when it is first required, so the
  // margin has to be the first import of every module that can load it first.
  for (const file of ['../src/companion/server.js', '../src/runner.js', '../src/companion/setup.js', '../src/probe.js']) {
    const first = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').find(l => l.startsWith('import '))
    assert.match(first, /physics-margin\.js/, `${file} must import the physics margin first`)
  }
})
