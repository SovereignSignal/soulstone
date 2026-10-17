// Private offline lab only. Names are not secure identities on public servers.
// Chat never supplies code or privileged server commands.
export function parseChat(message) {
  if (!message.startsWith('!bot ')) return null
  const parts = message.trim().split(/\s+/).slice(1)
  if (parts.length === 1 && ['ping', 'status', 'come', 'follow', 'stop', 'resume', 'help'].includes(parts[0])) return { action: parts[0] }
  if (parts.length === 2 && parts[0] === 'gather' && /^\d{1,2}$/.test(parts[1]) && +parts[1] >= 1 && +parts[1] <= 32) return { action: 'gather', goal: { item: 'oak_log', count: +parts[1] } }
  if (parts.join(' ') === 'craft pickaxe') return { action: 'craft', goal: { item: 'wooden_pickaxe', count: 1 } }
  throw new Error('Use !bot help for commands')
}
// A line that starts with the teammate's name is a request in plain words, the
// same text the companion's box would send to the planner. It is not a command
// channel: the planner can only return validated plans, as for any request.
export function parseRequest(message, username = '') {
  const names = [username, username.replace(/\d+$/, ''), 'soulstone', 'soul'].filter(Boolean).map(n => n.replace(/[^A-Za-z0-9_]/g, ''))
  const any = [...new Set(names)].sort((a, b) => b.length - a.length).join('|'), line = String(message).trim()
  const match = new RegExp(`^@?(?:${any})[,:]?\\s+(.{2,400})$`, 'i').exec(line)
  if (match) return match[1].trim()
  // A mention anywhere in the line: "can you grab some coal @soul".
  const mention = new RegExp(`(^|\\s)@(?:${any})(?=$|[\\s,:.!?])[,:]?`, 'i')
  if (!mention.test(line)) return null
  const rest = line.replace(mention, ' ').replace(/\s+/g, ' ').trim()
  return rest.length >= 2 && rest.length <= 400 ? rest : null
}
// Short everyday words go straight to the fixed commands, aimed at whoever
// said them: no planning round, no completion criteria (3 October: "soul
// come" took a planning round and answered with the planner's bookkeeping).
const SIMPLE = { come: 'come', 'come here': 'come', 'come to me': 'come', 'come back': 'come', follow: 'follow', 'follow me': 'follow', stop: 'stop', wait: 'stop', 'stay': 'stop', status: 'status' }
export function simpleCommand(text) {
  const t = String(text || '').toLowerCase().replace(/^please\s+/, '').replace(/[\s.!?]+$/, '').trim()
  return SIMPLE[t] || null
}
export function attachChatControl(runner, bot) {
  // Who is heard: the admin's listening setting when there is one, otherwise
  // the owner alone (and anyone at all only when no owner is configured).
  const heard = name => name !== bot.username && (runner.listening ? runner.listening.allows(name, runner.owner) : !runner.owner || name.toLowerCase() === runner.owner.toLowerCase())
  // A private message is already addressed to the teammate, so the whole line
  // is the request: this is what a server alias like /soul delivers.
  bot.on('whisper', (name, message) => {
    // Named, never quoted: who was turned away is worth a line, what they said is not.
    if (!heard(name)) { if (name !== bot.username) runner.log?.('whisper_ignored', { name }); return }
    const line = String(message || '').trim()
    if (line.startsWith('!bot ')) { bot.emit('chat', name, line); return }
    const text = parseRequest(line, bot.username) || (line.length >= 2 && line.length <= 400 ? line : null)
    if (text && simpleCommand(text)) { bot.emit('chat', name, '!bot ' + simpleCommand(text)); return }
    if (text) { runner.log?.('chat_request', { name, private: true }); runner.emit('chat_request', { name, text, private: true }) }
  })
  bot.on('chat', (name, message) => {
    if (!heard(name)) return
    try {
      const command = parseChat(message)
      if (!command) {
        const text = parseRequest(message, bot.username)
        if (text && simpleCommand(text)) { bot.emit('chat', name, '!bot ' + simpleCommand(text)); return }
        if (text) { runner.log?.('chat_request', { name }); runner.emit('chat_request', { name, text }) }
        return
      }
      if (command.action === 'ping') { runner.say(`ack ${name}`); return }
      if (command.action === 'help') { runner.say('!bot follow | come | gather 10 | craft pickaxe | status | stop | resume'); return }
      if (command.action === 'follow' || command.action === 'come') {
        const entity = bot.players[name]?.entity
        if (!entity) throw new Error('I cannot see you yet')
        runner.command(command.action === 'follow' ? { action: 'follow', player: name } : { action: 'navigate', goal: { x: entity.position.x, y: entity.position.y, z: entity.position.z } })
      } else runner.command(command)
      if (runner.task && ['running', 'paused'].includes(runner.task.status) && command.action !== 'stop') runner.task.fromChat = true
      if (command.action === 'status') {
        const items = bot.inventory.items().slice(0, 5).map(i => `${i.count} ${i.name}`).join(', ') || 'empty inventory'
        runner.say(`${runner.task?.status || 'idle'}; ${items}`)
      } else if (command.action === 'stop') runner.say(`Stopped, ${name}.`)
      else runner.say(command.action === 'come' ? `On my way, ${name}!` : command.action === 'follow' ? `Following you, ${name}!` : `Accepted: ${command.action}`)
    } catch (error) { runner.say(error.message.slice(0, 150)) }
  })
}
// Idle company. A teammate with no job used to stand like a statue: the owner stood
// beside it in the play world (4 October) and saw nothing happen. Now, with
// nothing running, it turns to look at the nearest player within LOOK_RANGE,
// and it greets each player once per session when they join or first come
// near, with one line on how to talk to it.
export const LOOK_RANGE=8,GREET_RANGE=16
export function attachIdleCompany(runner,bot){
 // The name is read when needed: at attach time the login has not finished
 // and bot.username is not set yet (it greeted itself as "undefined").
 const greeted=new Set()
 const greet=who=>{
  const name=bot.username
  if(!who||!name||who===name||greeted.has(who))return
  if(runner.listening&&!runner.listening.allows(who,runner.owner))return
  greeted.add(who);runner.say(`Hi ${who}! I am ${name}. Say "soul" and what you want, like: soul, follow me.`)
 }
 const idle=()=>!['running','paused'].includes(runner.task?.status)&&!bot.pathfinder?.isMoving?.()
 const near=range=>Object.values(bot.players||{}).filter(p=>p.username!==bot.username).map(p=>p.entity).filter(e=>e&&e!==bot.entity&&e.position&&bot.entity?.position)
  .map(e=>({e,d:e.position.distanceTo(bot.entity.position)})).filter(x=>x.d<=range).sort((a,b)=>a.d-b.d)
 let ticks=0
 bot.on('physicsTick',()=>{
  if(++ticks%10)return
  try{
   for(const {e} of near(GREET_RANGE))greet(e.username)
   if(!idle())return
   const nearest=near(LOOK_RANGE)[0];if(!nearest)return
   bot.lookAt(nearest.e.position.offset(0,nearest.e.height||1.62,0)).catch?.(()=>{})
  }catch{}
 })
 bot.on('playerJoined',player=>{if(player?.username)setTimeout(()=>greet(player.username),3000)})
 return {greeted}
}
