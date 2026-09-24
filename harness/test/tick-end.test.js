import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import registry from 'prismarine-registry'
import { endClientTicks } from '../src/tick-end.js'

// A 26.3 server allows one position per client tick and only a
// ServerboundClientTickEnd closes the tick; mineflayer 4.38 never sends one,
// so the second position packet is kicked as invalid_player_movement.
function fakeBot(version) {
  const bot = new EventEmitter(), sent = []
  bot.registry = registry(version)
  bot._client = { write: (name, params) => sent.push([name, params]) }
  return { bot, sent }
}

test('every physics tick ends with tick_end where the protocol has it', () => {
  const { bot, sent } = fakeBot('1.21.4')
  endClientTicks(bot)
  for (let i = 0; i < 3; i++) bot.emit('physicsTick')
  assert.deepEqual(sent, [['tick_end', {}], ['tick_end', {}], ['tick_end', {}]])
})

test('a protocol without tick_end is never sent one', () => {
  const { bot, sent } = fakeBot('1.21.1')
  endClientTicks(bot)
  bot.emit('physicsTick')
  assert.deepEqual(sent, [])
})
