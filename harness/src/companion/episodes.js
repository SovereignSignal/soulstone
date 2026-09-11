import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Local research data, never an automatic training set. In-world outcomes and
// model claims deliberately have different event types and evidence labels.
export class EpisodeRecorder {
  constructor(directory, onError = () => {}) { this.directory = directory; this.onError = onError }
  start(metadata) {
    const id = randomUUID(), path = join(this.directory, `${id}.jsonl`)
    let sequence = 0, closed = false, disabled = false
    const write = (type, data) => {
      if (closed || disabled) return
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        appendFileSync(path, JSON.stringify({ version: 1, episodeId: id, sequence: sequence++, at: new Date().toISOString(), type, ...data }) + '\n', { mode: 0o600 })
      } catch {
        disabled = true
        this.onError('Gameplay recording failed; this episode will not be available for training review.')
      }
    }
    const episode = { id, write, end(status, data = {}) { write('end', { ...data, status, trainingEligible: false }); closed = true } }
    write('start', { ...metadata, scope: 'live-controller', trainingEligible: false })
    return episode
  }
}
