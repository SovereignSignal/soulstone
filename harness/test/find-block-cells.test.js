import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {findBlockCells,nearbyResources} from '../src/observations.js'
const require=createRequire(import.meta.url)
const registry=require('prismarine-registry')('1.21.4')
const Chunk=require('prismarine-chunk')(registry)
const World=require('prismarine-world')(registry)
const injectBlocks=require('mineflayer/lib/plugins/blocks.js')
// Lab runs 123 and 124 (pi1, 13 October): a resource scan held the bot's process 5 to
// 15 s at a time on a Raspberry Pi. mineflayer's findBlocks builds a block for every
// cell of a section with no palette list, and a one-block section (sky, a lava sea) has none.
// The replacement must give mineflayer's own answer, found without those blocks.
function world(seed=1){
 let s=seed;const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648
 const bot=new EventEmitter();bot._client=new EventEmitter();bot.registry=registry;bot.version='1.21.4'
 bot.game={minY:-64,height:384,dimension:'overworld'};bot.entity={position:new Vec3(3.5,64,-2.5)}
 injectBlocks(bot,{version:'1.21.4'});bot.world=new World(null).sync
 const state=n=>registry.blocksByName[n].defaultState
 const rare=['iron_ore','coal_ore','oak_log','spruce_log','crafting_table','diamond_ore']
 for(let cx=-4;cx<=3;cx++)for(let cz=-4;cz<=3;cz++){
  if(cx===3&&cz===3)continue // one column never loaded
  const c=new Chunk({minY:-64,worldHeight:384})
  for(let x=0;x<16;x++)for(let z=0;z<16;z++){
   for(let y=-64;y<0;y++)c.setBlockStateId(new Vec3(x,y,z),state(y<-40&&cx<0?'lava':'stone'))
   for(let y=0;y<60;y++)c.setBlockStateId(new Vec3(x,y,z),state(rnd()<.004?rare[Math.floor(rnd()*rare.length)]:rnd()<.3?'dirt':'stone'))
   if(rnd()<.01)for(let y=64;y<70;y++)c.setBlockStateId(new Vec3(x,y,z),state('oak_log'))
  }
  bot.world.setColumn(cx,cz,c)
 }
 return bot
}
test('findBlockCells gives mineflayer findBlocks answer for every block, distance and count',()=>{
 for(const seed of [1,2,3]){
  const bot=world(seed)
  for(const name of ['iron_ore','coal_ore','oak_log','spruce_log','crafting_table','diamond_ore','stone','dirt','lava','air','obsidian'])
   for(const [maxDistance,count] of [[16,1],[32,2],[48,1],[48,5]])
    for(const point of [undefined,new Vec3(-20.5,-50,10.5),new Vec3(40,30,40)]){
     const id=registry.blocksByName[name].id,opts={maxDistance,count,...(point?{point}:{})}
     assert.deepEqual(findBlockCells(bot,id,opts).map(String),bot.findBlocks({matching:id,...opts}).map(String),`${name} ${maxDistance}/${count} from ${point||'bot'} (seed ${seed})`)
    }
 }
})
test('the resource scan builds no block for a cell it only has to look at',()=>{
 const bot=world(4);let built=0;const blockAt=bot.blockAt;bot.blockAt=(...a)=>{built++;return blockAt(...a)}
 const names=['oak_log','spruce_log','stone','coal_ore','iron_ore','crafting_table','obsidian']
 const found=nearbyResources(bot,names,{maxDistance:48,countPerKind:1})
 assert.ok(found.length>=3,'the world holds most of them')
 assert.equal(built,found.length,'one block per result, to confirm its name; none per cell scanned')
})
