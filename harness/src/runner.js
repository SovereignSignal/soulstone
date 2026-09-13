import {setTimeout as delay} from 'node:timers/promises'
import {PREPARE_ACTIONS} from './supplies.js'
import {EXPEDITION_ACTIONS} from './prospecting.js'
import {STATION_ACTIONS} from './stations.js'
import {DoorAwareMovements,correctDoorWaypoints} from './navigation.js'
import { isLog } from './resources.js'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'
import pathfinding from 'mineflayer-pathfinder'
import collection from 'mineflayer-collectblock'
import {worldIdentity} from './profile-identity.js'
import { loadTask, saveTask, validateGoal, validateTaskGoal } from './task-store.js'
import { executeSkill } from './skills.js'
import { attachChatControl } from './chat-control.js'

const { pathfinder, goals } = pathfinding
// A skill's deadline is an idle window: real progress slides it forward, up
// to a hard ceiling of three idle windows or thirty minutes, whichever is less.
export const MAX_TASK_MS = 30 * 60 * 1000
export class Runner extends EventEmitter {
  constructor({ host, port = 25565, username = 'HarnessRunner', version = '1.21.4', statePath, chatControl = false, owner = '', auth = 'offline', profilesFolder, onMsaCode, worldId, profileIdentity, authenticate }) {
    super()
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !['offline','microsoft'].includes(auth) || (auth === 'offline' ? !/^[A-Za-z0-9_]{1,16}$/.test(username) : typeof username !== 'string' || !username.trim() || username.length > 254)) throw new Error('invalid connection profile')
    this.options = { host, port, username, version: version === 'auto' ? false : version, auth, ...(auth === 'microsoft' ? {profilesFolder,onMsaCode} : {}), respawn: false }
    this.authenticate = authenticate
    this.profile = worldId ? worldIdentity(worldId,profileIdentity) : JSON.stringify(auth === 'offline' ? [host, port, username, version] : [host, port, username, version, auth])
    this.statePath = statePath
    this.chatControl = chatControl; this.owner = owner
    this.task = loadTask(statePath, this.profile)
    this.closed = false; this.ready = false; this.attempts = 0
    this.persist()
  }
  log(type, data = {}) { this.emit('event', { at: new Date().toISOString(), type, ...data }) }
  persist() { saveTask(this.statePath, this.profile, this.task) }
  start() {
    this.watchdog = setInterval(() => {
      if (['running', 'paused'].includes(this.task?.status) && Date.now() >= this.task.deadline) this.finish('failed', 'task deadline exceeded')
    }, 200)
    this.connect()
  }
  connect() {
    if (this.closed) return
    this.log('connecting', { attempt: this.attempts })
    let bot
    try { bot = mineflayer.createBot(this.authenticate ? {...this.options,auth:this.authenticate} : this.options) } catch (error) {
      this.log('connection_error', { reason: error.message }); this.retry(); return
    }
    this.bot = bot; bot.soulstoneInventoryResync = this.inventoryResync === true; this.connectionId = randomUUID()
    bot.loadPlugin(pathfinder)
    bot.on('path_update',result=>this.pathUpdated(bot,result))
    bot.loadPlugin(collection.plugin)
    if (this.chatControl) attachChatControl(this, bot)
    this.joinTimer = setTimeout(() => bot.end('join timeout'), this.options.auth === 'microsoft' ? 1200000 : 30000)
    bot.on('spawn', () => {
      if (this.bot !== bot || this.closed) return
      clearTimeout(this.joinTimer); clearTimeout(this.stableTimer)
      this.ready = true
      this.respawnPending = false; clearTimeout(this.respawnTimer)
      const movements = new DoorAwareMovements(bot)
      movements.canDig = false; movements.allow1by1towers = false
      movements.allowParkour = false; movements.allowFreeMotion = false
      movements.allowSprinting = false; movements.scafoldingBlocks = []
      movements.maxDropDown = 3
      if(bot.registry.blocksByName.sweet_berry_bush)movements.blocksToAvoid.add(bot.registry.blocksByName.sweet_berry_bush.id)
      bot.pathfinder.setMovements(movements)
      this.movements = movements
      const gathering = new DoorAwareMovements(bot)
      gathering.allow1by1towers = false; gathering.scafoldingBlocks = []; gathering.allowParkour = false
      gathering.maxDropDown = 3
      gathering.allowSprinting = false
      gathering.blocksToAvoid = new Set(movements.blocksToAvoid)
      gathering.exclusionAreasBreak.push(block => (isLog(block.name) || block.name.endsWith('_leaves')) ? 0 : 100)
      bot.collectBlock.movements = gathering
      bot.pathfinder.thinkTimeout = 3000
      this.stableTimer = setTimeout(() => { this.attempts = 0 }, 10000)
      this.log('spawn', { version: bot.version, position: this.position() })
      this.applyGoal()
    })
    bot.on('health',()=>{if(this.bot===bot&&this.ready)this.log('survival_tick')})
    // Air metadata belongs to one life. The server may not resend its default
    // on respawn, so retain unknown rather than the previous life's zero air.
    bot.on('respawn',()=>{if(this.bot===bot)bot.oxygenLevel=undefined})
    let lastSurvivalCheck=0
    bot.on('physicsTick', () => {
      // dig() can still be turning when Stop arrives. Cancel it on the next
      // physics tick if the native operation starts digging after that Stop.
      if(this.work?.bot===bot&&this.work.cancelled&&!this.work.finished&&bot.targetDigBlock)bot.stopDigging()
      if(this.bot===bot&&this.ready&&Date.now()-lastSurvivalCheck>=1000){lastSurvivalCheck=Date.now();this.log('survival_tick')}
      if (this.bot !== bot || !this.ready || this.task?.status !== 'running') return
      if (this.task.kind === 'follow') { this.applyFollow(); return }
      if (this.task.kind && this.task.kind !== 'navigate') return
      const distance = this.distance()
      if (distance <= 2) this.finish('completed', 'destination reached', { distance, position: this.position() })
    })
    bot.on('death', () => {
      if (this.bot !== bot) return
      this.ready = false; this.halt()
      this.respawnPending = false; clearTimeout(this.respawnTimer)
      if (this.task?.status === 'running') {
        this.task.status = 'paused'; this.task.reason = 'death: explicit resume required'; this.persist()
      }
      this.log('death', { task: this.task })
    })
    bot.on('kicked', reason => { if (this.bot === bot) this.log('kicked', {reason:JSON.stringify(reason)?.slice(0,2000)}) })
    bot.on('error', error => { if (this.bot === bot) this.log('connection_error', { reason: error.message }) })
    bot.on('end', () => {
      if (this.bot !== bot) return
      clearTimeout(this.joinTimer); clearTimeout(this.stableTimer)
      this.ready = false; this.bot = null
      this.respawnPending = false; clearTimeout(this.respawnTimer)
      if (this.work?.bot === bot) this.work.cancelled = true
      this.followEntity = null
      this.log('disconnected', { task: this.task })
      if (!this.closed) this.retry()
    })
  }
  retry() {
    if (this.closed) return
    if (++this.attempts > 5) {
      this.connectionExhausted = true
      if (['running', 'paused'].includes(this.task?.status)) this.finish('failed', 'reconnect limit exceeded')
      this.log('connection_exhausted'); this.close(); return
    }
    const delayMs = Math.min(1000 * 2 ** (this.attempts - 1), 16000)
    this.log('reconnecting', { delayMs })
    this.retryTimer = setTimeout(() => this.connect(), delayMs)
  }
  reconnect() {
    // A manual retry reopens only an exhausted connection. Healthy sessions,
    // pending retries and deliberate shutdowns must never create a second bot.
    if (!this.closed || !this.connectionExhausted) return false
    this.stop()
    this.bot = null; this.ready = false; this.closed = false
    this.connectionExhausted = false; this.attempts = 0
    this.start()
    return true
  }
  position() {
    const p = this.bot?.entity?.position
    return p ? { x: p.x, y: p.y, z: p.z } : null
  }
  distance() {
    const p = this.position(), g = this.task?.goal
    return p && g ? Math.hypot(p.x - g.x, p.y - g.y, p.z - g.z) : Infinity
  }
  halt() {
    this.followEntity = null
    if (this.work && !this.work.finished && this.work.bot === this.bot) {
      if(!this.work.cancelled)this.log('skill_cancelling',{taskId:this.task?.id,stage:this.work.stage})
      this.work.cancelled = true
    }
    this.bot?.pathfinder?.setGoal(null); this.bot?.clearControlStates()
    try { this.bot?.stopDigging() } catch {}
    try { this.bot?.deactivateItem() } catch {}
  }
  async waitForIdle(signal, timeoutMs = 20000) {
    const deadline=Date.now()+timeoutMs
    while(this.work && !this.work.finished && this.work.bot===this.bot){
      if(signal?.aborted)throw new Error('Cancelled')
      if(Date.now()>=deadline)throw new Error('Interrupted skill has not settled; refusing overlapping work')
      await delay(20,undefined,{signal})
    }
    if(signal?.aborted)throw new Error('Cancelled')
  }
  pathUpdated(bot,result) {
    if(this.bot!==bot)return
    correctDoorWaypoints(bot,result.path)
    // goto()-based skills own their errors. Plain navigation uses setGoal(),
    // so surface exhausted search here instead of waiting out its deadline.
    if(this.ready&&this.task?.status==='running'&&(!this.task.kind||this.task.kind==='navigate')&&['noPath','timeout'].includes(result.status)){
      this.finish('failed',result.status==='noPath'?'No walking route to the requested location; inspect current terrain and choose another approach':'Walking route search exceeded its time budget; inspect current terrain and choose another approach')
    }
  }
  applyGoal() {
    if (!this.ready || this.task?.status !== 'running') return
    if (Date.now() >= this.task.deadline) { this.finish('failed', 'task deadline exceeded'); return }
    if(this.task.kind==='defend'){
      if(this.task.goal.connectionId!==this.connectionId){this.finish('failed','Combat connection changed; re-observe before another encounter');return}
      this.runSkill();return
    }
    if (this.task.kind === 'follow') { this.applyFollow(); return }
    if (['gather', 'craft','acquire','build','construct','give','eat','harvest','surface','burrow','unburrow','hut','unhut','flee','hunt','climb','sleep',...PREPARE_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(this.task.kind)) { this.runSkill(); return }
    const g = this.task.goal
    this.bot.pathfinder.setGoal(new goals.GoalNear(g.x, g.y, g.z, 1))
    this.log('navigating', { task: this.task })
  }
  navigate(goal, timeoutMs = 120000) {
    goal = validateGoal(goal)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be 1000–600000')
    this.assertAvailable(); this.halt()
    this.task = { id: randomUUID(), goal, status: 'running', deadline: Date.now() + timeoutMs }
    this.persist(); this.log('task_started', { task: this.task }); this.applyGoal()
  }
  extend() {
    const t = this.task
    if (t?.status !== 'running' || !Number.isFinite(t.idleMs) || !Number.isFinite(t.hardDeadline)) return
    t.deadline = Math.min(t.hardDeadline, Date.now() + t.idleMs)
  }
  finish(status, reason, extra = {}) {
    const returnTo = this.task?.returnTo
    this.halt()
    if (this.task) { this.task.status = status; this.task.reason = reason; this.persist() }
    this.log('task_finished', { task: this.task, ...extra })
    if (status === 'completed') this.say(`Done: ${reason}`)
    else if (status === 'failed') this.say(`Task failed: ${reason}`)
    if (status === 'completed' && returnTo) this.follow(returnTo)
  }
  say(text) {
    if (!this.chatControl || !this.ready || !this.bot || Date.now() - (this.lastChat || 0) < 2000) return
    this.lastChat = Date.now(); this.bot.chat(String(text).replace(/[\r\n]/g, ' ').slice(0, 200))
  }
  assertAvailable() {
    if (this.work && !this.work.finished && this.work.bot === this.bot) throw new Error('Skill still active; use !bot stop first')
  }
  follow(player) {
    const goal = validateTaskGoal('follow', { player })
    this.assertAvailable(); this.halt()
    this.task = { id: randomUUID(), kind: 'follow', goal, status: 'running', deadline: Number.MAX_SAFE_INTEGER }
    this.persist(); this.log('following', { player }); this.applyGoal()
  }
  applyFollow() {
    if (!this.ready || this.task?.kind !== 'follow' || this.task.status !== 'running') return
    const target = this.bot.players[this.task.goal.player]?.entity
    if (target !== this.followEntity) {
      this.followEntity = target
      this.bot.pathfinder.setGoal(target ? new goals.GoalFollow(target, 3) : null, !!target)
    }
  }
  skill(kind, goal, timeoutMs = 180000) {
    if(kind==='give')goal={...goal,player:this.owner}
    goal = validateTaskGoal(kind, goal)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be 1000–600000')
    this.assertAvailable()
    const returnTo = this.task?.kind === 'follow' && this.task.status === 'running' ? this.task.goal.player : undefined
    this.halt()
    this.task = { id: randomUUID(), kind, goal, returnTo, status: 'running', deadline: Date.now() + timeoutMs, idleMs: timeoutMs, hardDeadline: Date.now() + Math.min(3 * timeoutMs, MAX_TASK_MS) }
    this.persist(); this.log('task_started', { task: this.task }); this.applyGoal()
  }
  async runSkill() {
    const bot = this.bot, task = this.task
    if (this.work && !this.work.finished && this.work.bot === bot) return
    const work = { bot, cancelled: false, finished: false, stage: 'observing' }; this.work = work
    const check = () => {
      if (work.cancelled || this.closed || this.bot !== bot || !this.ready || this.task !== task || task.status !== 'running') throw new Error('skill interrupted')
    }
    try {
      const result = await executeSkill(bot, task, { check, movements: this.movements, gatheringMovements: bot.collectBlock.movements,
        persist: () => { this.extend(); this.persist() },
        stage: value => { work.stage = value; this.extend() },
        progress: message => { check(); this.extend(); this.log('skill_progress', { message }); this.say(message) } })
      check(); work.finished = true
      task.result=task.navigationRecovery?{...result,navigationRecovery:structuredClone(task.navigationRecovery)}:result;this.finish('completed', task.kind==='construct'?`${result.verifiedBlocks}/${result.totalBlocks} blocks${result.partial?' (more to build)':''}`:`${result.count} ${result.item}`, result)
    } catch (error) {
      work.finished = true
      if (!work.cancelled && this.bot === bot && this.task === task && task.status === 'running') this.finish('failed', error.message)
    } finally {
      work.finished = true
      if(work.cancelled){
        // Old path timers and native operations have now finished. Restore the
        // ordinary movement policy before the next task acquires this bot.
        if(this.bot===bot){bot.pathfinder.setGoal(null);bot.clearControlStates();if(this.movements)bot.pathfinder.setMovements(this.movements)}
        this.log('skill_cancelled',{taskId:task.id,stage:work.stage})
      }
    }
  }
  stop() {
    if(this.task&&['completed','failed','cancelled'].includes(this.task.status)){this.halt();return}
    this.finish('cancelled', 'operator stop')
  }
  resume() {
    if (this.task?.status !== 'paused') throw new Error('only a paused task can resume; cancelled tasks need a new goal')
    if (Date.now() >= this.task.deadline) { this.finish('failed', 'task deadline exceeded'); return }
    this.task.status = 'running'; delete this.task.reason; this.extend(); this.persist()
    if (this.bot && !this.bot.isAlive) this.bot.respawn()
    else this.applyGoal()
  }
  respawn() {
    if(this.closed||!this.bot)throw new Error('Connect to Minecraft before respawning')
    if(this.bot.isAlive!==false||this.bot.health!==0)throw new Error('The agent is not dead')
    if(this.respawnPending){this.log('respawn_ignored',{reason:'respawn already pending'});return false}
    this.stop();this.respawnPending=true
    try{
      this.bot.respawn();this.log('respawn_requested')
      this.respawnTimer=setTimeout(()=>{this.respawnPending=false;this.log('respawn_timeout')},10000)
      return true
    }catch(e){this.respawnPending=false;throw e}
  }
  command(command) {
    if (!command || typeof command !== 'object') throw new Error('expected JSON command')
    if (this.closed) throw new Error('runner is closed')
    this.emit('operator_command', command)
    switch (command.action) {
      case 'navigate': this.navigate(command.goal, command.timeoutMs); break
      case 'follow': this.follow(command.player); break
      case 'gather': this.skill('gather', command.goal, command.timeoutMs); break
      case 'prepare': this.skill('prepare',command.goal,command.timeoutMs); break
      case 'acquire': this.skill('acquire', command.goal, command.timeoutMs); break
      case 'construct': this.skill('construct', command.goal, command.timeoutMs); break
      case 'build': this.skill('build', command.goal, command.timeoutMs); break
      case 'leave_base': case 'retreat': case 'stow': case 'prospect': case 'return_base': case 'place': case 'deposit': case 'withdraw': case 'smelt': case 'check_base': this.skill(command.action,command.goal,command.timeoutMs); break
      case 'defend': case 'harvest': case 'eat': case 'give': this.skill(command.action, command.goal, command.timeoutMs); break
      case 'surface': this.skill('surface',{},command.timeoutMs); break
      case 'burrow': this.skill('burrow',{},command.timeoutMs); break
      case 'unburrow': this.skill('unburrow',command.goal,command.timeoutMs); break
      case 'hut': this.skill('hut',{},command.timeoutMs); break
      case 'unhut': this.skill('unhut',{},command.timeoutMs); break
      case 'flee': this.skill('flee',command.goal,command.timeoutMs); break
      case 'climb': this.skill('climb',command.goal,command.timeoutMs); break
      case 'sleep': this.skill('sleep',command.goal,command.timeoutMs); break
      case 'hunt': this.skill('hunt',command.goal,command.timeoutMs); break
      case 'craft': this.skill('craft', command.goal, command.timeoutMs); break
      case 'stop': this.stop(); break
      case 'resume': this.resume(); break
      case 'status': this.log('status', { ready: this.ready, position: this.position(), health: this.bot?.health, task: this.task }); break
      case 'quit': this.close(); break
      default: throw new Error('allowed actions: navigate, follow, gather, craft, acquire, build, give, stop, resume, status, quit')
    }
  }
  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.retryTimer); clearTimeout(this.joinTimer); clearTimeout(this.stableTimer); clearTimeout(this.respawnTimer); clearInterval(this.watchdog)
    this.halt(); this.bot?.quit()
    this.log('closed', { task: this.task }); this.emit('closed')
  }
}
