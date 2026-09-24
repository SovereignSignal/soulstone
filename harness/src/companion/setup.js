import '../physics-margin.js'
import {readFileSync} from 'node:fs'
import mineflayer from 'mineflayer'
import minecraftData from 'minecraft-data'
import {isIP} from 'node:net'
import {bridgeRouteForVersion} from './version-bridge.js'
import {worldIdentity} from '../profile-identity.js'

export const supportedProtocols = new Set(mineflayer.testedVersions.map(version => minecraftData(version).version.version))

export function validateServer(value) {
  const host=typeof value?.host==='string'?value.host.trim():''
  const port=Number(value?.port), version=typeof value?.version==='string'?value.version.trim():'auto'
  if (!host || host.length>253 || (!isIP(host)&&!host.split('.').every(label=>/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label)))) throw new Error('Enter a server hostname or IP, without a port or URL')
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error('Server port must be between 1 and 65535')
  if (version!=='auto') {
    if (!/^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/.test(version)) throw new Error('Enter auto or a Java release such as 1.21.4 or 26.1')
    const data=minecraftData(version)
    if (!bridgeRouteForVersion(version) && (!data || !supportedProtocols.has(data.version.version))) throw new Error(`Java ${version} is not supported by this build. Bundled client releases span ${mineflayer.oldestSupportedVersion} through ${mineflayer.latestSupportedVersion}; use auto for a supported server.`)
  }
  return {host,port,version}
}

export function validateSetup(value,{allowIncomplete=false}={}) {
  if (!value || typeof value !== 'object') throw new Error('Missing setup profile')
  const text = key => typeof value[key] === 'string' ? value[key].trim() : ''
  const {host,port,version}=validateServer(value), owner=text('owner')
  const auth=text('auth'), model=text('model'), provider=text('provider')
  const minecraftAccountId=auth==='microsoft'?value.minecraftAccountId:undefined
  if(minecraftAccountId!==undefined&&minecraftAccountId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(minecraftAccountId))throw new Error('Choose a linked Minecraft account')
  const username=minecraftAccountId||text('username')
  if (!(allowIncomplete&&!owner) && !/^[A-Za-z0-9_]{1,16}$/.test(owner)) throw new Error('Enter your Minecraft Java player name')
  if (!['offline','microsoft'].includes(auth)) throw new Error('Choose a supported Minecraft login')
  if (!(allowIncomplete&&!username) && (auth==='offline' ? !/^[A-Za-z0-9_]{1,16}$/.test(username) : !username || username.length>254 || /[\s\x00-\x1f]/.test(username))) throw new Error('Enter a valid bot login')
  if (auth==='offline' && username && username.toLowerCase()===owner.toLowerCase()) throw new Error('The bot needs a different name from the player')
  if (!['codex','claude'].includes(provider) || (!(allowIncomplete&&!model) && !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(model))) throw new Error('Choose a subscription provider and exact model ID')
  if(value.name!==undefined&&value.name!==null&&(typeof value.name!=='string'||value.name.trim().length>80||/[\x00-\x1f\x7f]/.test(value.name)))throw new Error('Use a world name of up to 80 characters')
  const world=value.id===undefined?{}:{id:text('id'),identity:worldIdentity(text('id'),value.identity)}
  return {...world,host,port,owner,username,auth,version,provider,model,...(minecraftAccountId?{minecraftAccountId}:{})}
}
// Saving connection details never authenticates or opens a game session.
// Runtime loading keeps strict validation, even for an unfinished saved entry.
export function validateSavedConnection(value) { return validateSetup(value,{allowIncomplete:true}) }
export function loadSetup(path) { return validateSetup(JSON.parse(readFileSync(path,'utf8'))) }
