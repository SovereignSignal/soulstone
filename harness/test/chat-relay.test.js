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
