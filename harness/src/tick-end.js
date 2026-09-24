// Minecraft 26.3 kicks a client that sends a second position before it ends its
// tick (ServerboundClientTickEnd, in the protocol since 1.21.2). The vanilla
// client ends every tick; mineflayer 4.38 never does, so through the 26.3 route
// the bot was kicked about a second after every spawn. mineflayer emits
// physicsTick just before it sends the tick's position, so ending the tick there
// keeps one position per tick. Older protocols have no such packet.
export function endClientTicks(bot) {
  let supported
  bot.on('physicsTick', () => {
    supported ??= !!bot.registry?.protocol?.play?.toServer?.types?.packet_tick_end
    if (supported) bot._client.write('tick_end', {})
  })
}
