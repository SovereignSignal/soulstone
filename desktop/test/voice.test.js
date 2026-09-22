import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {Voice} from '../voice.js'
function fixture(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};const voice=new Voice('fixture',{launch:()=>child});voice.start();const event=value=>child.stdout.write(JSON.stringify(value)+'\n');event({type:'ready',available:true});return {voice,event}}
test('Stop discards a late recognition result without sending a command',()=>{
 const {voice,event}=fixture(),texts=[];voice.on('text',text=>texts.push(text));voice.talk();const id=voice.id;voice.cancel();event({type:'result',id,text:'dig straight down',confidence:1});assert.deepEqual(texts,[]);assert.equal(voice.listening,false);voice.close()
})
test('uncertain or empty speech asks for another try and never submits',()=>{
 const {voice,event}=fixture(),texts=[],events=[];voice.on('text',x=>texts.push(x));voice.on('event',x=>events.push(x));voice.talk();event({type:'result',id:voice.id,text:'something',confidence:.2});assert.deepEqual(texts,[]);assert.equal(events.at(-1).type,'retry');voice.close()
})
test('one completed recording sends once, exits listening, and ignores duplicate results',()=>{
 const {voice,event}=fixture(),texts=[],events=[];voice.on('text',x=>texts.push(x));voice.on('event',x=>events.push(x));voice.talk();const value={type:'result',id:voice.id,text:'Follow me',confidence:.9};event(value);event(value);assert.deepEqual(texts,['Follow me']);assert.equal(events.at(-1).type,'sent');assert.equal(voice.listening,false);voice.close()
})
test('missing speech language cannot silently start a recording',()=>{
 const {voice,event}=fixture();event({type:'ready',available:false});assert.throws(()=>voice.talk(),/microphone setup/);voice.close()
})
