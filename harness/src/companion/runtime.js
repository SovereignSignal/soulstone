import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
export async function startLocalModel({ binary, key, identifier }) {
  if (!binary || !key) return
  try {
    const response = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(2000) })
    const data = await response.json()
    if (data.data?.some(m => m.id === identifier)) return
  } catch {}
  await run(binary, ['server', 'start', '--port', '1234', '--bind', '127.0.0.1'], { timeout: 30000 })
  await run(binary, ['load', key, '--identifier', identifier, '--context-length', '4096', '--yes'], { timeout: 120000 })
}
