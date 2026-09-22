import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseAnnouncement,matchingWorld} from '../lan.js'
test('LAN announcements yield only valid addresses, labels and ports',()=>{
 const world=parseAnnouncement(Buffer.from('[MOTD]Player - Our world[/MOTD][AD]51234[/AD]'),'192.0.2.10')
 assert.equal(world.port,51234);assert.equal(world.motd,'Player - Our world')
 for(const text of ['[MOTD]world[/MOTD][AD]0[/AD]','[MOTD]world[/MOTD][AD]99999[/AD]','[MOTD]world\ncommand[/MOTD][AD]25565[/AD]','not a LAN announcement'])assert.equal(parseAnnouncement(Buffer.from(text),'192.0.2.10'),null)
})
test('changing LAN port preserves selection but different or ambiguous worlds never auto-connect',()=>{
 const saved={host:'192.0.2.10',motd:'Player - Our world'},world={...saved,port:51234}
 assert.equal(matchingWorld([world],saved).port,51234)
 assert.throws(()=>matchingWorld([{...world,motd:'Another world'}],saved),/Open your Minecraft/)
 assert.throws(()=>matchingWorld([{...world,host:'192.0.2.11'}],saved),/Open your Minecraft/)
 assert.throws(()=>matchingWorld([world,{...world,port:51235}],saved),/More than one/)
})
