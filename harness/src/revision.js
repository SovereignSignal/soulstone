// The harness revision that produced a lesson or a build. build.py writes
// src/revision.json for packaged apps; a checkout run reports its git commit.
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
let cached
export function harnessRevision(){
 if(cached)return cached
 try{const r=JSON.parse(readFileSync(new URL('./revision.json',import.meta.url),'utf8'));if(typeof r.revision==='string'&&r.revision)return cached=r.revision}catch{}
 try{return cached='git-'+execFileSync('git',['rev-parse','--short','HEAD'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:['ignore','pipe','ignore']}).toString().trim()}catch{}
 return cached='dev'
}

// Experience belongs to the actual executor, including hotfixes applied without
// rebuilding the package. Keep the display/build revision separate. Compute once
// per process, just like loaded modules; source updates require a restart.
export function sourceRevision(root){
 const hash=createHash('sha256')
 const visit=(dir,relative='')=>{
  for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
   const name=relative+entry.name,path=join(dir,entry.name)
   if(entry.isDirectory())visit(path,name+'/')
   else if(entry.isFile()&&/\.(js|txt|json)$/.test(entry.name)&&name!=='revision.json'){
    hash.update(name).update('\0').update(readFileSync(path)).update('\0')
   }
  }
 }
 visit(root)
 return 'source-'+hash.digest('hex')
}
let executor
export function executorRevision(){return executor??=sourceRevision(fileURLToPath(new URL('.',import.meta.url)))}
