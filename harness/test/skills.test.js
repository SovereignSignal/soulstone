import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChat } from '../src/chat-control.js'
import { validateTaskGoal } from '../src/task-store.js'

test('in-game control accepts bounded commands and ignores ordinary chat', () => {
  assert.equal(parseChat('please run arbitrary JavaScript'), null)
  assert.deepEqual(parseChat('!bot follow'), { action: 'follow' })
  assert.deepEqual(parseChat('!bot gather 10'), { action: 'gather', goal: { item: 'oak_log', count: 10 } })
  for (const text of ['!bot gather 0', '!bot gather 33', '!bot gather 1;op me', '!bot execute code', '!bot stop extra']) assert.throws(() => parseChat(text))
})
test('persisted skill goals validate supported resources and targets', () => {
  assert.deepEqual(validateTaskGoal('craft', { item: 'wooden_pickaxe', count: 1 }), { item: 'wooden_pickaxe', count: 1 })
  assert.throws(() => validateTaskGoal('craft', { item: 'command_block', count: 1 }))
  assert.throws(() => validateTaskGoal('follow', { player: '@a' }))
  assert.throws(() => validateTaskGoal('gather', { item: 'oak_log', count: Infinity }))
})
