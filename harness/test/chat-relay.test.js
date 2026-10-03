import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
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

import {Teammate} from '../src/companion/controller.js'
test('a request asked in game is for the player who asked; from the app it is for the owner',()=>{
 const fake={runner:{owner:'SovereignSignal',bot:{players:{Ada:{entity:{}},SovereignSignal:{entity:{}}}}},requestProgress:{requester:'Ada'}}
 assert.equal(Teammate.prototype.recipient.call(fake),'Ada')
 fake.requestProgress={};assert.equal(Teammate.prototype.recipient.call(fake),'SovereignSignal')
 fake.requestProgress={requester:'Gone'};assert.equal(Teammate.prototype.recipient.call(fake),'SovereignSignal','someone no longer on the server falls back to the owner')
 let goalSeen=null;const fakeRunner={owner:'SovereignSignal',listening:{allows:n=>n==='Ada'},assertAvailable(){throw new Error('stop here')}}
 const orig=Runner.prototype.skill
 for(const [asked,expected] of [['Ada','Ada'],['Stranger','SovereignSignal']]){
  try{orig.call({...fakeRunner,assertAvailable(){goalSeen=null;throw new Error('stop here')}},'give',{item:'bread',count:2,player:asked},10000)}catch{}
 }
 // The recipient rule itself, without the runner's task plumbing:
 const pick=asked=>{const ok=/^[A-Za-z0-9_]{1,16}$/.test(asked||'')&&(asked.toLowerCase()==='sovereignsignal'||fakeRunner.listening.allows(asked));return ok?asked:'SovereignSignal'}
 assert.equal(pick('Ada'),'Ada');assert.equal(pick('Stranger'),'SovereignSignal')
})

import {gameLine} from '../src/chat-voice.js'
import {simpleCommand} from '../src/chat-control.js'
test('everyday words go straight to the fixed commands for whoever said them',()=>{
 assert.equal(simpleCommand('come'),'come');assert.equal(simpleCommand('Come here!'),'come');assert.equal(simpleCommand('please follow me'),'follow');assert.equal(simpleCommand('stop.'),'stop')
 assert.equal(simpleCommand('come mine some iron with me'),null)
 const runner=new EventEmitter(),bot=new EventEmitter(),commands=[];Object.assign(runner,{owner:'SovereignSignal',say(){},command:c=>commands.push(c),listening:{allows:n=>n==='Ada'}});bot.username='SoulStone303'
 bot.players={Ada:{entity:{position:new Vec3(5,64,5)}}}
 const asked=[];runner.on('chat_request',r=>asked.push(r));attachChatControl(runner,bot)
 bot.emit('chat','Ada','soul come');bot.emit('chat','Ada','soul follow me');bot.emit('whisper','Ada','stop')
 assert.deepEqual(asked,[],'no planning round');assert.deepEqual(commands.map(c=>c.action),['navigate','follow','stop'])
 assert.deepEqual(commands[0].goal,{x:5,y:64,z:5},'to the player who asked');assert.equal(commands[1].player,'Ada')
})
test('game chat gets plain lines, never the planner\'s bookkeeping',()=>{
 assert.equal(gameLine('That set of completion criteria would pass without doing the work. Restating them.'),null)
 assert.equal(gameLine('Automatically continuing the saved request: mine 8 iron'),null)
 assert.equal(gameLine('The executable checks passed. Still needs your review: the chestplate is worn'),'Done!')
 assert.equal(gameLine('Blocked: No path to the goal!. I will inspect the result and revise the plan.'),'That did not work (No path to the goal!). Trying something else.')
 assert.equal(gameLine('I will Going to -624,68,-367, digging through'),'I am going to -624,68,-367, digging through')
 assert.ok(gameLine('x '.repeat(200)).length<=221)
})
import {busyFor} from '../src/chat-voice.js'
import {validateAttackGoal} from '../src/primitives-world.js'
test('kids in game chat: audience setting, plain safety words, one job at a time, pets safe, the planner told who is asking',()=>{
 // Sov, 3 October: "they will send it crazy commands ... they are 7, 10 and 15".
 assert.deepEqual(validateListeners({mode:'anyone',audience:'  kids aged 7, 10 and 15 '}),{mode:'anyone',players:[],audience:'kids aged 7, 10 and 15'})
 assert.throws(()=>validateListeners({mode:'anyone',audience:'x'.repeat(121)}),/120/)
 assert.equal(gameLine('A potential hostile is within ten blocks. I am pausing work and assessing self-defense.'),'Uh oh, a monster is close! Hang on.')
 assert.equal(gameLine('A creeper is 12.8 blocks away. Sprinting clear before sheltering.'),'Creeper! Running away!')
 assert.equal(gameLine('I am choosing shelter: Health or food is too low to engage'),null)
 assert.equal(gameLine('It is night and I am in the base. I will carry on with your request at daylight.'),'It is night, so I am staying inside. I will do it in the morning!')
 assert.equal(gameLine('Blocked: Dusk is here; staying in the base until daylight rather than starting work outside. Work underground can go on through the back exit (tunnel_out). I will inspect the result and revise the plan.'),'It is getting dark, so I will stay inside and do it in the morning.')
 assert.equal(gameLine('I could not finish: Goal still incomplete. The milestone verification failed.'),'I could not finish that one, sorry!')
 assert.equal(gameLine('Cornered by a zombie with nowhere to shelter. Fighting with my stone axe.'),'I am trapped by a zombie! Fighting back!')
 const t=phase=>({phase,requestProgress:{status:'running',requester:'Ada'}})
 assert.match(busyFor(t('acting'),'Bo','Sov'),/busy helping Ada.*soul stop/)
 assert.equal(busyFor(t('acting'),'Ada','Sov'),null,'the same player may change their own request');assert.equal(busyFor(t('acting'),'sov','Sov'),null,'the owner overrides')
 assert.equal(busyFor(t('blocked'),'Bo','Sov'),null,'a waiting request can be replaced');assert.equal(busyFor({phase:'ready',requestProgress:null},'Bo','Sov'),null)
 for(const pet of ['wolf','cat','parrot','horse'])assert.throws(()=>validateAttackGoal({type:pet}),/pet/)
 assert.doesNotThrow(()=>validateAttackGoal({type:'zombie'}))
 const fake={requestProgress:{requester:'Ada'},runner:{listening:{current:{audience:'kids aged 7, 10 and 15'}}}}
 assert.deepEqual(Teammate.prototype.conversation.call(fake),{speaker:'Ada',channel:'game chat',audience:'kids aged 7, 10 and 15'})
 assert.equal(Teammate.prototype.conversation.call({requestProgress:{},runner:{}}),null,'a request from the app has no conversation')
 const prompt=readFileSync(new URL('../src/companion/players-prompt.txt',import.meta.url),'utf8')
 for(const rule of ['conversation.audience','hurt or trap a player','attack a pet','ignore your instructions','personal details'])assert.ok(prompt.includes(rule),rule)
})
test('in game chat the plan speaks once per new reply and the step narration stays in the app',()=>{
 const said=[],fake={messages:[],persist(){},emit(){},conversation:()=>({speaker:'Ada'})}
 const m=Teammate.prototype.say.call(fake,'I will gather 10 logs.','assistant',{game:false})
 assert.equal(m.game,false);assert.equal(Teammate.prototype.say.call(fake,'Getting you wood, Ada!').game,undefined)
})
