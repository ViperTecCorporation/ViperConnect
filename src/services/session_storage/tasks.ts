import { randomUUID } from 'node:crypto'
import { SessionStorageCatalog } from './catalog'
import { SessionStorageError, SessionStorageRedis, StorageProgress, StorageTask, validateSessionPhone } from './types'
import { migrationCompletionResult } from './migration_completion'
import { sessionBackupsEnabled } from './backup_policy'

const PREFIX = 'unoapi-session-storage:task:'
const STALE_MS = 10 * 60 * 1000

export class SessionStorageTasks {
  constructor(readonly redis: SessionStorageRedis, readonly workerOwner = process.env.UNOAPI_STORAGE_WORKER_ID || process.env.UNOAPI_SERVER_NAME || 'server_1') {}
  async start(phone: string, operation: StorageTask['operation'], run: (taskId: string, progress: (value: StorageProgress) => Promise<void>) => Promise<unknown>, afterRelease?: () => Promise<unknown>) {
    validateSessionPhone(phone)
    if (!['migration', 'backup', 'restore', 'source-cleanup'].includes(operation)) throw new SessionStorageError(400, 'session_storage_operation_invalid')
    if (operation === 'migration' && !/^[A-Za-z0-9_.-]{1,120}$/.test(this.workerOwner)) throw new SessionStorageError(409, 'session_storage_wrong_owner')
    const now = Date.now(), task: StorageTask = { id: randomUUID(), phone, operation, status: 'running', createdAt: now, updatedAt: now, progress: { phase: 'queued' } }
    const key = PREFIX + phone + ':' + task.id, lock = PREFIX + 'lock:' + phone
    // Reserve the worker before metrics/copy/quiesce. Session-only locks allow
    // two different numbers to compete for the same worker's RAM, CPU and disk.
    const workerLock = operation === 'migration' ? `unoapi-session-storage:migration-lock:${this.workerOwner}` : undefined
    const keys = [lock, key, ...(workerLock ? [workerLock] : [])]
    const accepted = await this.redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; if #KEYS==3 and redis.call('EXISTS',KEYS[3])==1 then return -1 end; redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[3]); redis.call('SET',KEYS[2],ARGV[2],'EX',604800); if #KEYS==3 then redis.call('SET',KEYS[3],ARGV[1],'PX',ARGV[3]) end; return 1", { keys, arguments: [task.id, JSON.stringify(task), String(STALE_MS)] })
    if (Number(accepted) === -1) throw new SessionStorageError(409, 'session_storage_worker_migration_busy')
    if (Number(accepted) !== 1) throw new SessionStorageError(409, 'session_storage_busy')
    const save = async () => {
      task.updatedAt = Date.now()
      if (Number(await this.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] or (#KEYS==3 and redis.call('GET',KEYS[3])~=ARGV[1]) then return 0 end; redis.call('PEXPIRE',KEYS[1],ARGV[3]); if #KEYS==3 then redis.call('PEXPIRE',KEYS[3],ARGV[3]) end; redis.call('SET',KEYS[2],ARGV[2],'EX',604800); return 1", { keys, arguments: [task.id, JSON.stringify(task), String(STALE_MS)] })) !== 1) throw new SessionStorageError(409, 'session_storage_task_lost')
    }
    void (async () => {
      let lost = false
      const heartbeat = setInterval(() => { void save().catch(() => { lost = true }) }, 30000)
      heartbeat.unref?.()
      try { task.result = await run(task.id, async value => { if (lost) throw new SessionStorageError(409, 'session_storage_task_lost'); task.progress = value; await save() }); if (lost) throw new SessionStorageError(409, 'session_storage_task_lost'); task.status = 'ready'; task.progress = { phase: 'ready' } }
      catch (error) { task.status = 'failed'; task.error = error instanceof SessionStorageError ? error.code : 'session_storage_operation_failed'; delete task.result }
      finally { clearInterval(heartbeat) }
      try { if (!lost) await save() } finally {
        await this.redis.eval("local n=0; for _,key in ipairs(KEYS) do if redis.call('GET',key)==ARGV[1] then n=n+redis.call('DEL',key) end end; return n", { keys: [lock, ...(workerLock ? [workerLock] : [])], arguments: [task.id] })
      }
      // Socket reload must not race our own lifecycle reservation. The durable
      // completion record allows the owner's poll loop to resume after a crash.
      if (!lost && task.status === 'ready') await afterRelease?.()
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
    if (task.operation === 'migration' && task.status === 'ready') {
      const completion = await this.redis.get(`unoapi-session-storage:migration-completion:${phone}`)
      if (completion) { const plan = JSON.parse(completion); if (plan.phone === phone) task.result = migrationCompletionResult(plan, task.id, task.result) }
    }
    return task
  }
}

/** Invoked by the owner's bounded poll loop. Runs sequentially and claims two UTC windows/day. */
export class SessionBackupScheduler {
  private running = false
  constructor(readonly catalog: SessionStorageCatalog, readonly runtime: { sessions(): Promise<string[]>; backup(phone: string): Promise<void>; enabled?(): boolean }) {}
  async tick(now = Date.now()) {
    if (!(this.runtime.enabled ? this.runtime.enabled() : sessionBackupsEnabled())) return { skipped: true, completed: 0, failed: 0 }
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
