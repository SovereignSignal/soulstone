import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {EventEmitter} from 'node:events'

// Session IDs suppress late recognition after Stop, leaving a world, or a new recording.
export class Voice extends EventEmitter {
 constructor(binary,{launch=spawn}={}){super();Object.assign(this,{binary,launch});this.child=null;this.id=0;this.listening=false;this.ready=false;this.available=false}
 start(){
  if(this.child)return
  const child=this.child=this.launch(this.binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true})
  child.stdin.on('error',()=>{});child.stderr.on('data',()=>{})
  createInterface({input:child.stdout}).on('line',line=>{
   if(line.length>10000)return
   let value;try{value=JSON.parse(line)}catch{return}
   if(value.type==='ready'){this.available=true;this.ready=value.available!==false;this.emit('event',value);return}
   if(value.type==='error'&&(value.id===undefined||value.id===this.id)){this.listening=false;clearTimeout(this.timer);this.emit('event',{type:'error',message:value.message||'Ask a grown-up to check the microphone.'});return}
   if(value.id!==this.id)return
   if(value.type==='result'){
    if(!this.listening)return
    this.listening=false;clearTimeout(this.timer)
    const text=typeof value.text==='string'?value.text.trim().slice(0,2000):''
    if(text&&Number(value.confidence)>=0.55){this.emit('event',{type:'sent'});this.emit('text',text)}
    else this.emit('event',{type:'retry',message:'I didn’t catch that. Press Talk and try again.'})
   }else if(value.type==='listening'||value.type==='transcript')this.emit('event',{type:value.type,text:String(value.text||'').slice(0,2000)})
  })
  const failed=()=>{if(this.child!==child)return;this.child=null;this.ready=false;this.available=false;this.listening=false;clearTimeout(this.timer);this.emit('event',{type:'error',message:'Voice is unavailable. Ask a grown-up to check setup.'})}
  child.on('error',failed);child.on('exit',failed)
 }
 send(value){if(!this.child)throw new Error('Voice is not ready. Ask a grown-up to check setup.');this.child.stdin.write(JSON.stringify(value)+'\n')}
 talk(){
  if(!this.ready)throw new Error('Ask a grown-up to check microphone setup first.')
  if(this.listening){this.send({type:'finish',id:this.id});return}
  this.id++;this.listening=true;this.send({type:'listen',id:this.id});this.timer=setTimeout(()=>{if(this.listening)this.send({type:'finish',id:this.id})},20000)
 }
 cancel(){++this.id;this.listening=false;clearTimeout(this.timer);if(this.child)this.send({type:'cancel'});this.emit('event',{type:'cancelled'})}
 speak(text){if(this.available&&!this.listening&&typeof text==='string'&&text.trim())this.send({type:'speak',text:text.slice(0,600)})}
 close(){this.cancel();const child=this.child;this.child=null;if(child){child.stdin.end();setTimeout(()=>child.kill(),1000).unref()}}
}
