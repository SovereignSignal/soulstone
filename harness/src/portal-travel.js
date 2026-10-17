// Which dimensions the bot may enter through a portal, per world
// (the Nether plan). Off is the harness as it was: never
// through a portal, anywhere. The admin turns the Nether on for a world; the owner's
// play world stays off until he says. The End has its own switch beside it
// (the dragon roadmap, brief 3), off in the same way until the owner says on.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
export const PORTAL_TRAVEL_SETTINGS=['off','on']
export function validatePortalTravel(value={}){
 const nether=value.nether??'off',end=value.end??'off'
 if(!PORTAL_TRAVEL_SETTINGS.includes(nether))throw new Error(`Nether travel must be one of: ${PORTAL_TRAVEL_SETTINGS.join(', ')}`)
 if(!PORTAL_TRAVEL_SETTINGS.includes(end))throw new Error(`End travel must be one of: ${PORTAL_TRAVEL_SETTINGS.join(', ')}`)
 return {nether,end}
}
export class PortalTravel {
 constructor(path){
  this.path=path
  // A missing or damaged file is off: the switch fails closed.
  let saved=null
  try{saved=validatePortalTravel(JSON.parse(readFileSync(path,'utf8')))}catch{}
  this.current=saved||validatePortalTravel()
 }
 snapshot(){return {nether:this.current.nether,end:this.current.end,settings:[...PORTAL_TRAVEL_SETTINGS]}}
 allows(dimension){return dimension==='the_nether'?this.current.nether==='on':dimension==='the_end'&&this.current.end==='on'}
 // A save that names one switch leaves the other where it was.
 save(value){
  this.current=validatePortalTravel({...this.current,...value})
  mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify(this.current,null,1),{mode:0o600})
  return this.snapshot()
 }
}
