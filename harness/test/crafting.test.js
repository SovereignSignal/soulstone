import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {craftWithWindowState} from '../src/crafting.js'

test('table clicks retain their own revision when inventory offhand updates interleave',async()=>{
 const client=new EventEmitter(),sent=[]
 const original=client.write=function(name,p){assert.equal(this,client);sent.push({name,...p})}
 const bot={_client:client,supportFeature:()=>true,async craft(){
  client.emit('packet',{windowId:1,stateId:1},{name:'window_items'})
  client.emit('packet',{windowId:0,stateId:43,slot:45},{name:'set_slot'})
  client.write('window_click',{windowId:1,stateId:43,slot:10})
  client.emit('packet',{windowId:1,stateId:2,slot:0},{name:'set_slot'})
  client.emit('packet',{windowId:0,stateId:44,slot:45},{name:'set_slot'})
  client.write('window_click',{windowId:1,stateId:44,slot:1})
  client.write('window_click',{windowId:0,stateId:2,slot:9})
  client.write('close_window',{windowId:1})
  return 'crafted'
 }}
 assert.equal(await craftWithWindowState(bot,{},1,{}),'crafted')
 assert.deepEqual(sent.map(p=>p.stateId),[1,2,44,undefined])
 assert.equal(client.write,original);assert.equal(client.listenerCount('packet'),0)
})

test('craft revision tracking cleans up on failure and preserves legacy clients',async()=>{
 const client=new EventEmitter(),original=client.write=()=>{}
 const bot={_client:client,supportFeature:()=>true,async craft(){throw new Error('missing ingredient')}}
 await assert.rejects(craftWithWindowState(bot,{},1,{}),/missing ingredient/)
 assert.equal(client.write,original);assert.equal(client.listenerCount('packet'),0)
 bot.supportFeature=()=>false;bot.craft=async()=>{assert.equal(client.write,original);return 'legacy'}
 assert.equal(await craftWithWindowState(bot,{},1,null),'legacy')
})

test('a source-slot server correction settles before the next ingredient click',async()=>{
 const client=new EventEmitter();client.write=()=>{}
 const pending=new Set();let revision=0
 const bot={_client:client,currentWindow:{id:1},supportFeature:()=>true,
  async clickWindow(slot){
   assert.equal(pending.size,0,'previous click must finish server correction before another click')
   pending.add(slot)
   setTimeout(()=>{pending.delete(slot);client.emit('packet',{windowId:1,stateId:++revision,slot:0},{name:'set_slot'})},20)
  },
  async craft(){await this.clickWindow(10);await this.clickWindow(1);assert.equal(pending.size,0)}
 }
 const original=bot.clickWindow
 await craftWithWindowState(bot,{},1,{})
 assert.equal(bot.clickWindow,original)
})

test('cancellation during table stabilization restores transport and click handlers',async()=>{
 const client=new EventEmitter(),originalWrite=client.write=()=>{};let cancelled=false
 const originalClick=async()=>{cancelled=true}
 const bot={_client:client,currentWindow:{id:1},clickWindow:originalClick,supportFeature:()=>true,async craft(){await this.clickWindow(10)}}
 await assert.rejects(craftWithWindowState(bot,{},1,{},()=>{if(cancelled)throw new Error('cancelled')}),/cancelled/)
 assert.equal(client.write,originalWrite);assert.equal(bot.clickWindow,originalClick);assert.equal(client.listenerCount('packet'),0)
})

test('inventory-grid crafting waits for server corrections even with no open container',async()=>{
 const client=new EventEmitter();client.write=()=>{};const pending=new Set();let revision=0
 const bot={_client:client,currentWindow:null,inventory:{id:0},supportFeature:()=>true,
  async clickWindow(slot){assert.equal(pending.size,0,'previous inventory-grid click must settle');pending.add(slot);setTimeout(()=>{pending.delete(slot);client.emit('packet',{windowId:0,stateId:++revision,slot:0},{name:'set_slot'})},20)},
  async craft(){await this.clickWindow(10);await this.clickWindow(1);assert.equal(pending.size,0)}
 }
 await craftWithWindowState(bot,{},1,null)
})

test('translated crafting requests full state once per click and waits for authoritative confirmation',async()=>{
 const client=new EventEmitter(),sent=[];let pending=false
 client.write=(name,packet)=>{if(name==='window_click'){assert.equal(packet.stateId,-1);sent.push(packet);pending=true;setTimeout(()=>{pending=false;client.emit('packet',{windowId:0,stateId:sent.length},{name:'window_items'})},25)}}
 const bot={_client:client,inventory:{id:0},soulstoneInventoryResync:true,supportFeature:()=>true,
  async clickWindow(slot){assert.equal(pending,false);client.write('window_click',{windowId:0,stateId:10,slot})},
  async craft(){await this.clickWindow(10);await this.clickWindow(1)}
 }
 await craftWithWindowState(bot,{},1,null)
 assert.equal(sent.length,2);assert.equal(pending,false)
})
