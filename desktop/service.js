import {randomBytes} from 'node:crypto'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createInterface} from 'node:readline'

export class CompanionService {
 constructor({fork,harness,root,environment,killTree}){Object.assign(this,{fork,harness,root,environment,killTree});this.child=null;this.url=null;this.starting=null}
 async start(profile){
  if(this.child||this.starting)throw new Error('A play session is already open.')
  this.token=randomBytes(32).toString('hex')
  const cwd=join(this.root,'worlds',profile.id);mkdirSync(cwd,{recursive:true,mode:0o700})
  const setup=join(cwd,'connection.json');writeFileSync(setup,JSON.stringify(profile),{mode:0o600})
  this.child=this.fork(join(this.harness,'src/companion/server.js'),[],{cwd,stdio:'pipe',env:{...this.environment,MC_SETUP_FILE:setup,MC_ACCOUNTS_DIR:join(this.root,'accounts'),MC_COMPANION_TOKEN:this.token,MC_RECORD_EPISODES:'0'},serviceName:'SoulStone teammate'})
  const child=this.child
  child.stderr.on('data',()=>{})
  child.once('exit',()=>{if(this.child===child){this.child=null;this.url=null}})
  this.starting=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('SoulStone took too long to start. Try Play again.')),20000)
   const fail=()=>{clearTimeout(timer);reject(new Error('SoulStone could not start. Ask a grown-up to check setup.'))}
   child.once('exit',fail)
   createInterface({input:child.stdout}).on('line',line=>{
    if(line.length>4096)return
    let data;try{data=JSON.parse(line)}catch{return}
    if(data.type==='companion_ready'&&Number.isInteger(data.port)&&data.port>0&&data.port<65536){
     clearTimeout(timer);child.removeListener('exit',fail);this.url=`http://127.0.0.1:${data.port}`;resolve()
    }
   })
  })
  try{await this.starting}catch(error){await this.shutdown();throw error}finally{this.starting=null}
 }
 async request(path,body){
  if(!this.url)throw new Error('Press Play to join your world first.')
  const response=await fetch(this.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000),redirect:'error'})
  const value=await response.json();if(!response.ok)throw new Error(value.error||'SoulStone could not do that.');return value
 }
 async shutdown(){
  const child=this.child;if(!child)return
  const exited=new Promise(resolve=>child.once('exit',resolve))
  try{if(this.url)await this.request('/shutdown',{})}catch{}
  let timer
  // taskkill must see the living root to enumerate its descendants on Windows.
  // Wait for the tree kill before terminating an unresponsive utility process.
  await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(async()=>{try{await this.killTree(child)}finally{child.kill();resolve()}},6500)})]);clearTimeout(timer)
  if(this.child===child){this.child=null;this.url=null}
 }
}
