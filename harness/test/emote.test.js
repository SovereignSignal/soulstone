import {test} from 'node:test'
import assert from 'node:assert/strict'
import {performEmote,validateEmoteGoal,EMOTES} from '../src/emote.js'
import {validatePlan} from '../src/companion/planner.js'
// The creative world, 14 October 2026: a child's first word to the bot was "jump", and
// it answered that it could not jump on command.
function fakeBot(){
 const log=[];return {log,entity:{yaw:1,pitch:0},setControlState(k,v){log.push(`${k}:${v}`)},swingArm(h){log.push(`swing:${h}`)},async look(y,p){log.push(`look:${y.toFixed(2)},${p.toFixed(2)}`)}}
}
const api={check(){},stage(){},progress(){}}
test('jump hops the asked number of times and leaves the jump key released',async()=>{
 const bot=fakeBot();const r=await performEmote(bot,{kind:'emote',goal:{move:'jump',count:3}},api,{beatMs:1})
 assert.equal(bot.log.filter(l=>l==='jump:true').length,3);assert.equal(bot.log.at(-2),'jump:false');assert.deepEqual(r,{item:'emote',count:3,move:'jump',receipt:'performed'})
})
test('wave swings both arms, spin looks round four quarters and comes back to the start, nod dips the head',async()=>{
 const wave=fakeBot();await performEmote(wave,{kind:'emote',goal:{move:'wave',count:2}},api,{beatMs:1});assert.equal(wave.log.filter(l=>l.startsWith('swing')).length,4)
 const spin=fakeBot();await performEmote(spin,{kind:'emote',goal:{move:'spin',count:1}},api,{beatMs:2});assert.equal(spin.log.filter(l=>l.startsWith('look')).length,5,'four quarters and the return');assert.equal(spin.log.at(-1),'look:1.00,0.00')
 const nod=fakeBot();await performEmote(nod,{kind:'emote',goal:{move:'nod',count:1}},api,{beatMs:1});assert.ok(nod.log.some(l=>l==='look:1.00,0.60'))
})
test('the goal and the planner step are validated',()=>{
 assert.throws(()=>validateEmoteGoal({move:'fly',count:1}),/one of/);assert.throws(()=>validateEmoteGoal({move:'jump',count:9}),/1 to 5/)
 assert.deepEqual(validateEmoteGoal({move:'dance'}),{move:'dance',count:1})
 for(const move of EMOTES)assert.equal(validatePlan({reply:'Boing!',steps:[{action:'emote',name:'',item:move,count:2,design:[],target:null}]}).steps[0].item,move)
 assert.throws(()=>validatePlan({reply:'',steps:[{action:'emote',name:'',item:'fly',count:1,design:[],target:null}]}),/Emote needs/)
})
