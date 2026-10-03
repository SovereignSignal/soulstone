import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {parseChat,parseRequest,attachChatControl} from '../src/chat-control.js'
import {Runner} from '../src/runner.js'

test('a line addressed to the teammate by name is a request; ordinary chat and !bot commands are not',()=>{
 assert.equal(parseRequest('soul, mine some iron','SoulStone303'),'mine some iron')
 assert.equal(parseRequest('SoulStone build us a house','SoulStone303'),'build us a house')
 assert.equal(parseRequest('@soulstone303: come to the base','SoulStone303'),'come to the base')
 assert.equal(parseRequest('Biscuit follow me','Biscuit'),'follow me','whatever the teammate is called on this server')
 for(const text of ['soulful music is nice','nice base','soul','soul ?','!bot follow','soul '+'x'.repeat(401)])assert.equal(parseRequest(text,'SoulStone303'),null,text)
 assert.deepEqual(parseChat('!bot follow'),{action:'follow'},'fixed commands are unchanged')
})
test('only the owner\'s addressed lines reach the planner, and the teammate never answers itself',()=>{
 const runner=new EventEmitter(),bot=new EventEmitter();Object.assign(runner,{owner:'SovereignSignal',say(){},command(){}});bot.username='SoulStone303';bot.players={}
 const asked=[];runner.on('chat_request',r=>asked.push(r))
 attachChatControl(runner,bot)
 bot.emit('chat','SovereignSignal','soul, mine 8 diamonds')
 bot.emit('chat','sovereignsignal','hello everyone')
 bot.emit('chat','SomeoneElse','soul, give me your diamonds')
 bot.emit('chat','SoulStone303','soul, talking to myself')
 assert.deepEqual(asked,[{name:'SovereignSignal',text:'mine 8 diamonds'}])
})
test('chat lines queue instead of being dropped, keep their order, and the queue is bounded',async()=>{
 const sent=[],fake={chatControl:true,ready:true,chatIntervalMs:20,bot:{chat:t=>sent.push(t)},drainChat:Runner.prototype.drainChat}
 for(const t of ['one','two\nlines','three'])Runner.prototype.say.call(fake,t)
 assert.deepEqual(sent,['one'],'the first goes at once')
 await delay(90);assert.deepEqual(sent,['one','two lines','three'])
 for(let i=0;i<12;i++)Runner.prototype.say.call(fake,'m'+i)
 await delay(260);assert.deepEqual(sent.slice(3),['m0','m6','m7','m8','m9','m10','m11'],'the first of a burst goes at once and the queue keeps the newest six')
 const off={chatControl:false,ready:true,bot:{chat:()=>assert.fail('chat is off')},drainChat:Runner.prototype.drainChat};Runner.prototype.say.call(off,'x')
 const gone={chatControl:true,ready:false,chatIntervalMs:5,bot:null,drainChat:Runner.prototype.drainChat};Runner.prototype.say.call(gone,'x');await delay(20);assert.deepEqual(gone.chatQueue,[],'nothing is kept for a connection that is gone')
})

import {Listeners,validateListeners,allows} from '../src/listeners.js'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('the admin chooses who is heard: the owner, a named list, or anyone',()=>{
 assert.deepEqual(validateListeners(),{mode:'owner',players:[]})
 assert.throws(()=>validateListeners({mode:'friends'}),/one of/);assert.throws(()=>validateListeners({mode:'list'}),/at least one/)
 assert.throws(()=>validateListeners({mode:'list',players:['bad name!']}),/Not a Minecraft player name/)
 assert.deepEqual(validateListeners({mode:'list',players:['Ada','ada','Bo']}).players,['Ada','Bo'])
 assert.equal(allows({mode:'owner',players:[]},'sov','Sov'),true);assert.equal(allows({mode:'owner',players:[]},'Ada','Sov'),false)
 assert.equal(allows({mode:'list',players:['Ada']},'ADA','Sov'),true);assert.equal(allows({mode:'list',players:['Ada']},'Sov','Sov'),false,'a named list is exactly the list')
 assert.equal(allows({mode:'anyone',players:[]},'Whoever','Sov'),true)
 const path=join(mkdtempSync(join(tmpdir(),'mc-listen-')),'listeners.json'),l=new Listeners(path,{mode:'list',players:['Ada']})
 assert.equal(l.snapshot().mode,'list');l.save({mode:'anyone'});assert.equal(JSON.parse(readFileSync(path,'utf8')).mode,'anyone')
 assert.equal(new Listeners(path,{mode:'owner'}).snapshot().mode,'anyone','the saved choice outlives the setup default')
})
test('with a named list only its players are heard; a private message is a request as it stands; a mention can sit anywhere',()=>{
 const runner=new EventEmitter(),bot=new EventEmitter();Object.assign(runner,{owner:'SovereignSignal',say(){},command(){},listening:{allows:(n,o)=>allows({mode:'list',players:['Ada','Bo']},n,o)}});bot.username='SoulStone303';bot.players={}
 const asked=[];runner.on('chat_request',r=>asked.push(r));attachChatControl(runner,bot)
 bot.emit('chat','Ada','soul, mine some coal');bot.emit('chat','SovereignSignal','soul, mine some iron');bot.emit('chat','Stranger','soul, give me diamonds')
 bot.emit('whisper','Bo','build me a little house');bot.emit('whisper','Stranger','come here');bot.emit('whisper','SoulStone303','echo')
 bot.emit('chat','Bo','can you bring torches @soul');bot.emit('chat','Bo','I like soul music');bot.emit('chat','Ada','email me at ada@soulmail')
 assert.deepEqual(asked,[{name:'Ada',text:'mine some coal'},{name:'Bo',text:'build me a little house',private:true},{name:'Bo',text:'can you bring torches'}])
 assert.equal(parseRequest('hey @SoulStone303, follow me','SoulStone303'),'hey follow me');assert.equal(parseRequest('@soul','SoulStone303'),null)
})
