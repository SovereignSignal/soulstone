// Which dimensions the bot may enter through a portal, per world
// (workstreams/minecraft/nether-plan.md). Off is the harness as it was: never
// through a portal, anywhere. The admin turns the Nether on for a world; Sov's
// family world stays off until he says. The End is not part of this switch.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
export const PORTAL_TRAVEL_SETTINGS=['off','on']
export function validatePortalTravel(value={}){
 const nether=value.nether??'off'
 if(!PORTAL_TRAVEL_SETTINGS.includes(nether))throw new Error(`Nether travel must be one of: ${PORTAL_TRAVEL_SETTINGS.join(', ')}`)
 return {nether}
}
export class PortalTravel {
 constructor(path){
  this.path=path
  // A missing or damaged file is off: the switch fails closed.
  let saved=null
  try{saved=validatePortalTravel(JSON.parse(readFileSync(path,'utf8')))}catch{}
  this.current=saved||validatePortalTravel()
 }
 snapshot(){return {nether:this.current.nether,settings:[...PORTAL_TRAVEL_SETTINGS]}}
 allows(dimension){return dimension==='the_nether'&&this.current.nether==='on'}
 save(value){
  this.current=validatePortalTravel(value)
  mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify(this.current,null,1),{mode:0o600})
  return this.snapshot()
 }
}
