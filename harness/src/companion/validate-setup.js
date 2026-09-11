import {validateSetup,validateSavedConnection} from './setup.js'
import {checkConnection} from './connection-check.js'
import {discoverModels} from './model-discovery.js'
try {
  let input=''
  for await (const chunk of process.stdin) { input+=chunk; if(input.length>10000) throw new Error('Setup is too large') }
  const value=JSON.parse(input)
  const result=process.argv.includes('--models')?await discoverModels(value):process.argv.includes('--check')?await checkConnection(value):process.argv.includes('--save-profile')?validateSavedConnection(value):validateSetup(value)
  // The protocol library may retain a socket-close timer after a completed
  // status ping. This one-shot CLI has no work left after flushing its result.
  process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(0))
} catch(error) { process.stderr.write(error.message+'\n',()=>process.exit(1)) }
