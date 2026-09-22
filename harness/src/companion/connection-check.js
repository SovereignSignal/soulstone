import protocol from 'minecraft-protocol'
import minecraftData from 'minecraft-data'
import {bridgeRoutes,bridgeRouteForVersion,bridgeRouteForProtocol,bridgeClientVersion,bridgeAvailable} from './version-bridge.js'
import {supportedProtocols,validateServer} from './setup.js'

export function connectionFailure(reason) {
  const text=String(reason||'').toLowerCase()
  if(/profile not found.*restart your launcher/.test(text))return 'Minecraft has not recognized this new Java profile for multiplayer yet. SoulStone retries once with a refreshed session. If attempts stop, wait briefly and reconnect.'
  if(/name_taken|duplicate_login|already.*(?:connected|logged)|logged.*another location/.test(text))return 'This account is already playing in the target world. Leave that server in Minecraft, or select a different account. A LAN host cannot leave without closing the world.'
  if(/whitelist|white.list|allowlist|not_whitelisted/.test(text))return 'This bot account is not on the server allowlist. Ask the server owner to allow it.'
  if(/invalid.session|unverified_username|failed to verify|authentication|authenticate|loginfailed|not authenticated|multiplayer.disabled|insufficient.?privileges/.test(text))return 'Minecraft account access failed. Check Microsoft sign-in, Java ownership and multiplayer permissions.'
  if(/outdated|incompatible|unsupported.*version|version.*not supported|protocol version/.test(text))return 'The Minecraft version is incompatible. Use auto for a supported server or update SoulStone for a newer protocol.'
  if(/enotfound|eai_again/.test(text))return 'The server name could not be resolved. Check the address and any required VPN.'
  if(/econnrefused/.test(text))return 'The connection was refused. Check that the world is open and that its port is correct.'
  if(/etimedout|ehostunreach|enetunreach|timeout/.test(text))return 'The server did not respond. Check that it is running and reachable from this Mac, including any required VPN.'
  return 'Could not join Minecraft. Check the server address, bot account, allowlist and Java version.'
}

export function describeServer(status,version='auto',helperReady=bridgeAvailable()) {
  const number=status?.version?.protocol
  const advertised=String(status?.version?.name||'unknown').replace(/[\x00-\x1f]/g,'').slice(0,80)
  if(!Number.isInteger(number))return {status:'unknown',message:'The server replied without a recognizable Java protocol. Account access has not been checked.'}
  const route=bridgeRouteForProtocol(number),selected=bridgeRouteForVersion(version)
  if(route && (version==='auto'||version===route.version))return helperReady ? {status:'reachable',route:'bridge',serverVersion:route.version,clientVersion:bridgeClientVersion,protocol:number,message:`Server responds as ${advertised}. SoulStone will use its compatibility mode. A linked Java account is required; sign-in and gameplay are checked when joining.`} : {status:'unsupported',protocol:number,message:`Java ${route.version} needs SoulStone’s compatibility helper and the Java runtime from Minecraft Launcher. Launch Minecraft once, then reopen SoulStone.`}
  if(selected && number!==selected.protocol)return {status:'mismatch',protocol:number,message:`Server responds as ${advertised}, which differs from selected Java ${version}. Use auto or the correct server version.`}
  if(!supportedProtocols.has(number))return {status:'unsupported',message:`Server advertises ${advertised} (protocol ${number}), which needs a compatibility update. This build has verified bridge routes for ${bridgeRoutes.map(r=>r.version).join(', ')}. Check for a newer SoulStone compatibility bundle before connecting.`,protocol:number}
  if(version!=='auto'&&minecraftData(version)?.version.version!==number)return {status:'mismatch',message:`Server advertises ${advertised}, which differs from selected Java ${version}. Try auto unless the server provides protocol translation.`,protocol:number}
  return {status:'reachable',message:`Server responds as ${advertised}. Its advertised protocol is supported. Bot sign-in and allowlist access will be checked when connecting.`,protocol:number}
}

export async function checkConnection(value) {
  const {host,port,version}=validateServer(value)
  try {
    // Status ping only: no login, player spawn, chat or model call.
    const status=await protocol.ping({host,port,version:version==='auto'||bridgeRouteForVersion(version)?false:version,closeTimeout:5000,noPongTimeout:1000})
    const result=describeServer(status,version)
    if(result.route==='bridge'&&value.auth==='offline')return {...result,status:'account_required',message:`Link a Minecraft Java account to use ${result.serverVersion} compatibility mode.`}
    return result
  } catch(error) {return {status:'unreachable',message:connectionFailure(error.message)}}
}
