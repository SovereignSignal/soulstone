import {startVersionBridge} from '../src/companion/version-bridge.js'
import {createInterface} from 'node:readline'
const store={read:()=>({uuid:'a'.repeat(32),name:'LifecycleFixture'})}
const bridge=await startVersionBridge({host:'127.0.0.1',port:1,store,accountId:'fixture'})
console.log(JSON.stringify({pid:bridge.pid,port:bridge.port}))
createInterface({input:process.stdin}).once('line',async()=>{await bridge.close();process.exit(0)})
