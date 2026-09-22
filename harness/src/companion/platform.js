import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {win32,posix} from 'node:path'

// Explicit roots only. Never execute an untrusted java/CLI from the working directory.
export function findJava({platform=process.platform,env=process.env,home=homedir(),exists=existsSync}={}) {
 const path=platform==='win32'?win32:posix, candidates=[]
 for(const root of [env.MC_JAVA_HOME,env.JAVA_HOME])if(root&&path.isAbsolute(root))candidates.push(path.join(root,'bin',platform==='win32'?'java.exe':'java'))
 const roots=platform==='win32'
  ? [env.APPDATA&&path.join(env.APPDATA,'.minecraft','runtime'),env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Packages','Microsoft.4297127D64EC6_8wekyb3d8bbwe','LocalCache','Local','runtime'),env['ProgramFiles(x86)']&&path.join(env['ProgramFiles(x86)'],'Minecraft Launcher','runtime')]
  : [path.join(home,platform==='darwin'?'Library/Application Support/minecraft/runtime':'.minecraft/runtime')]
 for(const root of roots.filter(Boolean))for(const name of ['java-runtime-epsilon','java-runtime-delta']) {
  if(platform==='darwin')candidates.push(path.join(root,name,'mac-os-arm64',name,'jre.bundle/Contents/Home/bin/java'))
  else if(platform==='win32')for(const arch of ['windows-x64','windows-arm64','windows-x86'])candidates.push(path.join(root,name,arch,name,'bin/java.exe'))
  else candidates.push(path.join(root,name,'linux',name,'bin/java'))
 }
 return candidates.find(exists)||null
}

export function stopProcessTree(child,{platform=process.platform,launch=spawn,signal='SIGTERM'}={}) {
 if(!Number.isSafeInteger(child?.pid)||child.pid<1)return
 if(platform==='win32') {
  const root=process.env.SystemRoot||'C:\\Windows'
  const killer=launch(win32.join(root,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
  return new Promise(resolve=>{
   let settled=false
   const finish=failed=>{if(settled)return;settled=true;clearTimeout(timer);if(failed){try{child.kill()}catch{}}resolve()}
   const timer=setTimeout(()=>finish(true),3000);timer.unref()
   killer.once('error',()=>finish(true));killer.once('close',code=>finish(code!==0))
  })
 } else {try{process.kill(-child.pid,signal)}catch{try{child.kill(signal)}catch{}}}
}
