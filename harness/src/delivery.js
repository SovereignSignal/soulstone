import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
const {goals}=pathfinding

// A drop is not a delivery. Count only pickup packets for newly observed item
// entities near our toss position, collected by the configured recipient.
export async function deliverItem(bot,task,{check,progress,stage,movements,persist}) {
  const {item,count,player}=task.goal
  if(task.delivery?.attempted)throw new Error('Delivery was already attempted; receipt is uncertain. Check the recipient before sending more.')
  const inventoryCount=()=>bot.inventory.items().filter(i=>i.name===item).reduce((n,i)=>n+i.count,0)
  if(inventoryCount()<count)throw new Error(`Need ${count} ${item} in inventory before delivery`)
  const target=()=>bot.players[player]?.entity
  if(!target())throw new Error('Recipient is not visible; ask them to come into view')
  check();stage('walking');progress(`Bringing ${count} ${item.replaceAll('_',' ')} to ${player}`)
  bot.pathfinder.setMovements(movements)
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),15000)
  try {await bot.pathfinder.goto(new goals.GoalFollow(target(),1.5))}
  finally {clearTimeout(timer);bot.pathfinder.setGoal(null)}
  bot.clearControlStates()
  check()
  const recipient=target()
  if(!recipient||bot.entity.position.distanceTo(recipient.position)>2.5)throw new Error('Recipient moved out of delivery range; no items sent')
  if(Object.values(bot.players).some(p=>p.entity&&p.entity.id!==recipient.id&&p.entity.id!==bot.entity.id&&p.entity.position.distanceTo(recipient.position)<4))throw new Error('Another player is too close to the recipient; no items sent')
  await bot.lookAt(recipient.position.offset(0,0.4,0),true);check()
  // Forced look changes local angles immediately, but the movement packet is
  // sent on a physics tick. Flush it before a drop uses the server's old yaw.
  await bot.waitForTicks(2);check()
  if(target()!==recipient||bot.entity.position.distanceTo(recipient.position)>2.5)throw new Error('Recipient moved before the handoff; no items sent')
  const stack=bot.inventory.items().find(i=>i.name===item)
  if(!stack||inventoryCount()<count)throw new Error('Inventory changed before delivery; no items sent')
  const before=inventoryCount(),origin=bot.entity.position.clone(),existing=new Set(Object.keys(bot.entities).map(Number)),candidates=new Map()
  let wrongCollector=false
  const onDrop=entity=>{
    if(existing.has(entity.id)||entity.position.distanceTo(origin)>3)return
    const dropped=entity.getDroppedItem?.()
    if(dropped?.name===item&&!candidates.has(entity.id))candidates.set(entity.id,{count:dropped.count,collected:0})
  }
  const onCollect=packet=>{
    const tracked=candidates.get(packet.collectedEntityId)
    if(!tracked)return
    if(packet.collectorEntityId!==recipient.id){wrongCollector=true;return}
    const amount=packet.pickupItemCount
    if(!Number.isInteger(amount)||amount<=0)return
    const accepted=Math.min(amount,tracked.count-tracked.collected,count-task.delivery.received)
    if(accepted<=0)return
    tracked.collected+=accepted;task.delivery.received+=accepted
    task.delivery.pickups.push({entityId:packet.collectedEntityId,recipientId:recipient.id,count:accepted})
    persist()
  }
  task.delivery={attempted:true,item,count,player,received:0,pickups:[]}
  // Persist before the consuming action. Uncertain delivery is never replayed.
  persist();bot.on('itemDrop',onDrop);bot._client.on('collect',onCollect)
  try {
    check();stage('delivering');await bot.toss(stack.type,null,count);check()
    progress('Items sent; checking recipient pickup')
    const deadline=Date.now()+8000
    while(Date.now()<deadline){
      check()
      if(wrongCollector)throw new Error('Another entity picked up the dropped item; delivery is not confirmed. No automatic resend.')
      if(task.delivery.received===count&&inventoryCount()<=before-count){
        task.delivery.confirmed=true;persist()
        return {item,count,player,receipt:'recipient_pickup',pickups:task.delivery.pickups}
      }
      await delay(50)
    }
    throw new Error(`Recipient pickup not confirmed (${task.delivery.received}/${count}); items may be on the ground. No automatic resend.`)
  } finally {bot.off('itemDrop',onDrop);bot._client.off('collect',onCollect)}
}
