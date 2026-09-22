import {cpSync,mkdirSync,readFileSync,readdirSync,existsSync,writeFileSync,rmSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {parseArgs} from 'node:util'

const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(desktop,'..'),resources=join(desktop,'resources')
const {values}=parseArgs({options:{target:{type:'string',default:process.platform}}}),target=values.target
if(!['win32','darwin'].includes(target))throw new Error('Choose a Windows or macOS desktop target.')
function run(binary,args,options={}){const result=spawnSync(binary,args,{cwd:root,encoding:'utf8',...options});if(result.error||result.status!==0)throw new Error(result.error?.message||result.stderr||'Build command failed');return result.stdout.trim()}
function copy(name){cpSync(join(root,name),join(resources,name),{recursive:true,dereference:true})}
mkdirSync(resources,{recursive:true});rmSync(join(resources,'voice'),{recursive:true,force:true});mkdirSync(join(resources,'voice'),{recursive:true})
mkdirSync(join(desktop,'ui/assets'),{recursive:true})
cpSync(join(root,'companion/Resources/Soul.png'),join(desktop,'ui/assets/Soul.png'))
// An explicit shipping list excludes .env, credentials, saved worlds and lab receipts.
// Rebuild only the generated resources directory, never app data.
rmSync(join(resources,'harness'),{recursive:true,force:true})
for(const name of ['harness/src','harness/blueprints','harness/package.json','harness/package-lock.json'])copy(name)
const assets=join(root,'harness/bridge'),manifest=JSON.parse(readFileSync(join(assets,'compatibility.json'),'utf8'))
for(const [name,hash] of [[manifest.jar,manifest.sha256],[manifest.source,manifest.sourceSha256]])if(createHash('sha256').update(readFileSync(join(assets,name))).digest('hex')!==hash)throw new Error('Compatibility asset integrity check failed: '+name)
const adapter=manifest.jar.replace('ViaProxy-','SoulStoneBridge-')
const classes=join(resources,'bridge-classes');mkdirSync(classes,{recursive:true})
const javaHome=process.env.JAVA_HOME
let javac=javaHome?join(javaHome,'bin',process.platform==='win32'?'javac.exe':'javac'):'javac'
if(process.platform==='darwin'&&!javaHome){const {findJava}=await import('../../harness/src/companion/platform.js');const java=findJava();if(java)javac=join(dirname(java),'javac')}
run(javac,['-proc:none','--release','17','-cp',join(assets,manifest.jar),'-d',classes,...readdirSync(join(root,'companion/bridge')).filter(f=>f.endsWith('.java')).map(f=>join(root,'companion/bridge',f))])
const bridge=join(resources,'harness/bridge');mkdirSync(bridge,{recursive:true})
for(const name of [manifest.jar,manifest.source,'compatibility.json','ViaProxy-LICENSE'])cpSync(join(assets,name),join(bridge,name))
cpSync(join(root,'companion/bridge'),join(bridge,'source'),{recursive:true})
cpSync(join(root,'companion/bridge/viaproxy.yml'),join(classes,'viaproxy.yml'))
const mf=join(resources,'bridge-manifest.mf');writeFileSync(mf,`Manifest-Version: 1.0\nMain-Class: soulstone.SoulStoneLauncher\nClass-Path: ${manifest.jar}\nLauncher-Agent-Class: net.raphimc.viaproxy.ViaProxy\n\n`)
run(join(dirname(javac),process.platform==='win32'?'jar.exe':'jar'),['cfm',join(bridge,adapter),mf,'-C',classes,'.'])
rmSync(classes,{recursive:true,force:true});rmSync(mf)
// A clean production install avoids carrying local development packages or caches.
const npm=process.platform==='win32'?'npm.cmd':'npm'
run(npm,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:join(resources,'harness'),shell:process.platform==='win32'})
if(target==='win32'&&process.platform==='win32'){
 const systemRoot=process.env.SystemRoot||'C:\\Windows',powershell=join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
 const speech=run(powershell,['-NoProfile','-NonInteractive','-Command',"[Reflection.Assembly]::LoadWithPartialName('System.Speech').Location"])
 if(!speech||!existsSync(speech))throw new Error('Windows System.Speech is required to build voice.')
 const framework=join(systemRoot,'Microsoft.NET/Framework64/v4.0.30319')
 run(join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/out:'+join(resources,'voice/SoulStoneVoice.exe'),'/reference:'+speech,'/reference:'+join(framework,'System.Web.Extensions.dll'),join(desktop,'native/Voice.cs')])
}else if(target==='win32'){
 run(process.env.SOULSTONE_DOTNET||'dotnet',['build',join(desktop,'native/SoulStoneVoice.csproj'),'--configuration','Release','--output',join(resources,'voice'),'--nologo'],{env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1'}})
}else if(process.platform==='darwin'){
 run('xcrun',['swiftc','-target','arm64-apple-macos14.0','-framework','Speech','-framework','AVFoundation',join(desktop,'native/Voice.swift'),'-o',join(resources,'voice/SoulStoneVoice')])
}else throw new Error('Build desktop resources on Windows or Apple Silicon macOS.')
console.log('Prepared clean desktop resources, compatibility bridge and native voice helper.')
