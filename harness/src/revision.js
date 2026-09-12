// The harness revision that produced a lesson or a build. build.py writes
// src/revision.json for packaged apps; a checkout run reports its git commit.
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
let cached
export function harnessRevision(){
 if(cached)return cached
 try{const r=JSON.parse(readFileSync(new URL('./revision.json',import.meta.url),'utf8'));if(typeof r.revision==='string'&&r.revision)return cached=r.revision}catch{}
 try{return cached='git-'+execFileSync('git',['rev-parse','--short','HEAD'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:['ignore','pipe','ignore']}).toString().trim()}catch{}
 return cached='dev'
}
