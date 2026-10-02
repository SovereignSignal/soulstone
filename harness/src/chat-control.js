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
  const match = new RegExp(`^@?(?:${[...new Set(names)].sort((a, b) => b.length - a.length).join('|')})[,:]?\\s+(.{2,400})$`, 'i').exec(String(message).trim())
  return match ? match[1].trim() : null
}
export function attachChatControl(runner, bot) {
  bot.on('chat', (name, message) => {
    if (name === bot.username || (runner.owner && name.toLowerCase() !== runner.owner.toLowerCase())) return
    try {
      const command = parseChat(message)
      if (!command) {
        const text = parseRequest(message, bot.username)
        if (text) runner.emit('chat_request', { name, text })
        return
      }
      if (command.action === 'ping') { runner.say(`ack ${name}`); return }
      if (command.action === 'help') { runner.say('!bot follow | come | gather 10 | craft pickaxe | status | stop | resume'); return }
      if (command.action === 'follow' || command.action === 'come') {
        const entity = bot.players[name]?.entity
        if (!entity) throw new Error('I cannot see you yet')
        runner.command(command.action === 'follow' ? { action: 'follow', player: name } : { action: 'navigate', goal: { x: entity.position.x, y: entity.position.y, z: entity.position.z } })
      } else runner.command(command)
      if (command.action === 'status') {
        const items = bot.inventory.items().slice(0, 5).map(i => `${i.count} ${i.name}`).join(', ') || 'empty inventory'
        runner.say(`${runner.task?.status || 'idle'}; ${items}`)
      } else if (command.action === 'stop') runner.say('Stopped. New work needs a new command.')
      else runner.say(`Accepted: ${command.action}`)
    } catch (error) { runner.say(error.message.slice(0, 150)) }
  })
}
