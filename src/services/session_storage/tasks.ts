import { randomUUID } from 'node:crypto'
import { SessionStorageCatalog } from './catalog'
import { SessionStorageError, SessionStorageRedis, StorageProgress, StorageTask, validateSessionPhone } from './types'

const PREFIX = 'unoapi-session-storage:task:'
const STALE_MS = 10 * 60 * 1000

export class SessionStorageTasks {
  constructor(readonly redis: SessionStorageRedis) {}
  async start(phone: string, operation: StorageTask['operation'], run: (taskId: string, progress: (value: StorageProgress) => Promise<void>) => Promise<unknown>) {
    validateSessionPhone(phone)
    if (!['migration', 'backup', 'restore', 'source-cleanup'].includes(operation)) throw new SessionStorageError(400, 'session_storage_operation_invalid')
    const now = Date.now(), task: StorageTask = { id: randomUUID(), phone, operation, status: 'running', createdAt: now, updatedAt: now, progress: { phase: 'queued' } }
    const key = PREFIX + phone + ':' + task.id, lock = PREFIX + 'lock:' + phone
    const accepted = await this.redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[3]); redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1", { keys: [lock, key], arguments: [task.id, JSON.stringify(task), String(STALE_MS)] })
    if (Number(accepted) !== 1) throw new SessionStorageError(409, 'session_storage_busy')
    const save = async () => {
      task.updatedAt = Date.now()
      if (Number(await this.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],ARGV[3]); redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1", { keys: [lock, key], arguments: [task.id, JSON.stringify(task), String(STALE_MS)] })) !== 1) throw new SessionStorageError(409, 'session_storage_task_lost')
    }
    void (async () => {
      let lost = false
      const heartbeat = setInterval(() => { void save().catch(() => { lost = true }) }, 30000)
      heartbeat.unref?.()
      try { task.result = await run(task.id, async value => { if (lost) throw new SessionStorageError(409, 'session_storage_task_lost'); task.progress = value; await save() }); if (lost) throw new SessionStorageError(409, 'session_storage_task_lost'); task.status = 'ready'; task.progress = { phase: 'ready' } }
      catch (error) { task.status = 'failed'; task.error = error instanceof SessionStorageError ? error.code : 'session_storage_operation_failed'; delete task.result }
      finally { clearInterval(heartbeat) }
      try { if (!lost) await save() } finally { await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [lock], arguments: [task.id] }) }
    })().catch(() => { /* Durable migration journal remains; stale task is reported as interrupted. */ })
    return task
  }

  async status(phone: string, taskId: string) {
    validateSessionPhone(phone)
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new SessionStorageError(400, 'session_storage_task_invalid')
    const raw = await this.redis.get(PREFIX + phone + ':' + taskId)
    if (!raw) throw new SessionStorageError(404, 'session_storage_task_not_found')
    const task: StorageTask = JSON.parse(raw)
    if (task.phone !== phone || task.id !== taskId) throw new SessionStorageError(409, 'session_storage_task_invalid')
    if (task.status === 'running' && Date.now() - task.updatedAt >= STALE_MS) task.status = 'interrupted'
    return task
  }
}

/** Invoked by the owner's bounded poll loop. Runs sequentially and claims two UTC windows/day. */
export class SessionBackupScheduler {
  private running = false
  constructor(readonly catalog: SessionStorageCatalog, readonly runtime: { sessions(): Promise<string[]>; backup(phone: string): Promise<void>; enabled?(): boolean }) {}
  async tick(now = Date.now()) {
    if (!(this.runtime.enabled ? this.runtime.enabled() : process.env.SESSION_STORAGE_BACKUP_ENABLED === 'true')) return { skipped: true, completed: 0, failed: 0 }
    if (this.running) return { skipped: true, completed: 0, failed: 0 }
    this.running = true
    let completed = 0, failed = 0
    try {
      for (const phone of await this.runtime.sessions()) {
        const reservation = await this.catalog.reserveBackupWindow(phone, now)
        if (!reservation) continue
        let lost = false, heartbeatTail = Promise.resolve()
        const heartbeat = setInterval(() => {
          heartbeatTail = heartbeatTail.then(async () => { if (!await this.catalog.renewBackupWindow(phone, reservation)) lost = true }).catch(() => { lost = true })
        }, 30000)
        heartbeat.unref?.()
        try {
          await this.runtime.backup(phone)
          clearInterval(heartbeat); await heartbeatTail
          if (lost || !await this.catalog.finishBackupWindow(phone, reservation, true)) throw new SessionStorageError(409, 'session_storage_backup_lease_lost')
          completed++
        } catch (error) {
          failed++
          await this.catalog.finishBackupWindow(phone, reservation, false, error instanceof SessionStorageError ? error.code : 'session_storage_backup_failed').catch(() => false)
        } finally { clearInterval(heartbeat); await heartbeatTail }
      }
      return { skipped: false, completed, failed }
    } finally { this.running = false }
  }
}
