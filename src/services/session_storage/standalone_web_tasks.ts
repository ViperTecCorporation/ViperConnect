import type { SessionStorageRedis, StorageTask } from './types'
import { SessionStorageError, validateSessionPhone } from './types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export const restoreTaskKey = (phone: string, id: string) => `unoapi-session-storage:task:${phone}:${id}`
const lockKey = (phone: string) => `unoapi-session-storage:standalone-job:${phone}`
export interface StandaloneWebTask extends StorageTask { owner: string }
export const SAVE_STANDALONE_WEB_TASK = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],600000); redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1`

/** One durable upload/job per phone. A lost RPC reply never creates another attempt. */
export class StandaloneWebTasks {
  constructor(readonly redis: SessionStorageRedis) {}
  async reserve(phone: string, id: string, owner: string) {
    validateSessionPhone(phone)
    if (!UUID.test(id) || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)) throw new SessionStorageError(400, 'session_storage_standalone_arguments_invalid')
    const now = Date.now(), task: StandaloneWebTask = { id, phone, owner, operation: 'restore', status: 'running', createdAt: now, updatedAt: now, progress: { phase: 'uploading' } }
    if (Number(await this.redis.eval("if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 or redis.call('EXISTS',KEYS[3])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',600000); redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1", {
      keys: [lockKey(phone), restoreTaskKey(phone, id), `unoapi-session-storage:task:lock:${phone}`], arguments: [id, JSON.stringify(task)],
    })) !== 1) throw new SessionStorageError(409, 'session_storage_busy')
    return task
  }
  async status(phone: string, id: string): Promise<StandaloneWebTask> {
    validateSessionPhone(phone)
    if (!UUID.test(id)) throw new SessionStorageError(400, 'session_storage_task_invalid')
    const raw = await this.redis.get(restoreTaskKey(phone, id))
    if (!raw) throw new SessionStorageError(404, 'session_storage_task_not_found')
    const task: StandaloneWebTask = JSON.parse(raw)
    if (task.id !== id || task.phone !== phone || task.operation !== 'restore') throw new SessionStorageError(409, 'session_storage_task_invalid')
    if (task.status === 'running' && Date.now() - task.updatedAt >= 600000) task.status = 'interrupted'
    return task
  }
  async save(task: StandaloneWebTask) {
    task.updatedAt = Date.now()
    if (Number(await this.redis.eval(SAVE_STANDALONE_WEB_TASK, { keys: [lockKey(task.phone), restoreTaskKey(task.phone, task.id)], arguments: [task.id, JSON.stringify(task)] })) !== 1) throw new SessionStorageError(409, 'session_storage_task_lost')
  }
  async release(task: StandaloneWebTask) {
    await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [lockKey(task.phone)], arguments: [task.id] })
  }
  async execute(phone: string, id: string, owner: string, run: () => Promise<unknown>) {
    const task = await this.status(phone, id)
    if (task.owner !== owner) throw new SessionStorageError(409, 'session_storage_wrong_owner')
    if (task.status !== 'running' || task.progress.phase !== 'queued') return task
    const claim = `unoapi-session-storage:standalone-claim:${phone}:${id}`
    if (Number(await this.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('EXISTS',KEYS[2])==1 then return 0 end; redis.call('SET',KEYS[2],ARGV[1],'EX',604800); return 1", { keys: [lockKey(phone), claim], arguments: [id] })) !== 1) return this.status(phone, id)
    task.progress = { phase: 'restoring' }; await this.save(task)
    void (async () => {
      let lost = false, tail = Promise.resolve()
      const timer = setInterval(() => { tail = tail.then(() => this.save(task)).catch(() => { lost = true }) }, 30000); timer.unref?.()
      try {
        task.result = await run()
        if (lost) throw new SessionStorageError(409, 'session_storage_task_lost')
        task.status = 'ready'; task.progress = { phase: 'ready' }
      } catch (error: any) {
        task.status = 'failed'; task.error = error instanceof SessionStorageError ? error.code : 'session_storage_standalone_restore_failed'
        task.result = error?.recovery ? { recovery: error.recovery, connected: false, replayed: false } : undefined
      } finally {
        clearInterval(timer); await tail
        try { if (!lost) await this.save(task) } finally { await this.release(task) }
      }
    })().catch(() => { /* Durable task/journal reports interruption; never retry or log credentials. */ })
    return task
  }
}
