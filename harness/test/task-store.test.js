import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTask, saveTask, validateGoal } from '../src/task-store.js'

const task = { id: 'test', status: 'running', goal: { x: 10, y: -60, z: 0 }, deadline: 10000 }
test('restart preserves goal, refuses another server profile, and expires stale work', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mc-state-')), 'task.json')
  saveTask(path, 'lab', task)
  assert.deepEqual(loadTask(path, 'lab', 1), task)
  assert.throws(() => loadTask(path, 'other', 1), /different profile/)
  assert.equal(loadTask(path, 'lab', 10001).status, 'failed')
  saveTask(path, 'lab', { ...task, status: 'cancelled' })
  assert.equal(loadTask(path, 'lab', 1).status, 'cancelled')
  assert.equal(JSON.parse(readFileSync(path)).schema, 1)
  writeFileSync(path, '{broken')
  assert.throws(() => loadTask(path, 'lab'), /Cannot load/)
})
test('invalid or dangerous navigation coordinates fail closed', () => {
  for (const goal of [null, {}, { x: NaN, y: 0, z: 0 }, { x: 0, y: 1000, z: 0 }, { x: 30000000, y: 0, z: 0 }]) assert.throws(() => validateGoal(goal))
  assert.deepEqual(validateGoal(task.goal), task.goal)
})
