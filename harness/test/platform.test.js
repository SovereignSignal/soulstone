import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {findJava,stopProcessTree} from '../src/companion/platform.js'
import {clientBinary,subscriptionEnv} from '../src/companion/subscriptions.js'

test('Windows discovers launcher Java with spaces, without accepting relative Java roots',()=>{
 const expected='C:\\Users\\Child Name\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-epsilon\\windows-x64\\java-runtime-epsilon\\bin\\java.exe',visited=[]
 assert.equal(findJava({platform:'win32',home:'C:\\Users\\Child Name',env:{APPDATA:'C:\\Users\\Child Name\\AppData\\Roaming',JAVA_HOME:'.\\unsafe'},exists:p=>{visited.push(p);return p===expected}}),expected)
 assert.ok(visited.every(p=>!p.includes('unsafe')))
})
test('a bundled Java root works on both desktop platforms',()=>{
 assert.equal(findJava({platform:'win32',env:{MC_JAVA_HOME:'C:\\Program Files\\SoulStone\\java'},exists:p=>p==='C:\\Program Files\\SoulStone\\java\\bin\\java.exe'}),'C:\\Program Files\\SoulStone\\java\\bin\\java.exe')
 assert.equal(findJava({platform:'darwin',env:{MC_JAVA_HOME:'/Applications/SoulStone.app/java'},exists:p=>p==='/Applications/SoulStone.app/java/bin/java'}),'/Applications/SoulStone.app/java/bin/java')
})
test('Windows provider discovery uses native executables and never executes cmd wrappers or relative PATH',()=>{
 const expected='C:\\Users\\Parent\\.local\\bin\\claude.exe',visited=[]
 assert.equal(clientBinary('claude',{platform:'win32',home:'C:\\Users\\Parent',env:{},searchPath:'.;relative;C:\\tools',canExecute:p=>{visited.push(p);return p===expected}}),expected)
 assert.ok(visited.every(p=>!p.endsWith('.cmd')))
 assert.throws(()=>clientBinary('codex',{platform:'win32',home:'C:\\Users\\Parent',env:{},searchPath:'.;relative',canExecute:()=>false}),/Install the native/)
})
test('Windows subscription children keep OS paths and discard paid keys and inherited task context',()=>{
 assert.deepEqual(subscriptionEnv({SystemRoot:'C:\\Windows',USERPROFILE:'C:\\Users\\Parent',APPDATA:'C:\\AppData',OPENAI_API_KEY:'secret',CODEX_THREAD_ID:'not-inherited',NODE_OPTIONS:'unsafe'}),{USERPROFILE:'C:\\Users\\Parent',APPDATA:'C:\\AppData',SystemRoot:'C:\\Windows'})
})
test('Windows finds the native Codex executable inside a global npm installation',()=>{
 const expected='C:\\Users\\Parent\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'
 assert.equal(clientBinary('codex',{platform:'win32',home:'C:\\Users\\Parent',env:{APPDATA:'C:\\Users\\Parent\\AppData\\Roaming'},searchPath:'',canExecute:p=>p===expected}),expected)
})
test('Windows stop kills the owned process tree using argument-separated taskkill',()=>{
 let captured
 stopProcessTree({pid:4321},{platform:'win32',launch:(...args)=>{captured=args;return new EventEmitter()}})
 assert.ok(captured[0].endsWith('taskkill.exe'));assert.deepEqual(captured[1],['/PID','4321','/T','/F']);assert.equal(captured[2].windowsHide,true)
 captured=null;stopProcessTree({pid:undefined},{platform:'win32',launch:()=>{captured=true}});assert.equal(captured,null)
})
test('Windows tree shutdown completes only after taskkill has finished enumerating children',async()=>{
 const killer=new EventEmitter();let finished=false,rootKills=0
 const done=stopProcessTree({pid:4321,kill:()=>rootKills++},{platform:'win32',launch:()=>killer}).then(()=>{finished=true})
 await Promise.resolve();assert.equal(finished,false);assert.equal(rootKills,0)
 killer.emit('close',0);await done;assert.equal(finished,true);assert.equal(rootKills,0)
})
