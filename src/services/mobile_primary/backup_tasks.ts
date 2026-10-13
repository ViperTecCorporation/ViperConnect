import { randomUUID } from 'node:crypto'
import { MobileDeviceError } from '../mobile_device_service'
import { validateBackupPassword } from './backup_archive'

const PREFIX = 'mobile-primary:{v1}:backup-task:'
const LOCK = PREFIX + 'lock'
const RETENTION = 86400
const RUN_MS = 10 * 60 * 1000
export interface BackupTask {
  id: string; deviceId: string; status: 'running' | 'ready' | 'failed' | 'interrupted'
  createdAt: number; expiresAt: number; error?: string
  updatedAt?: number
}
interface Dependencies {
  redis: { get(key: string): Promise<string | null>; eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }
  export(id: string, body: any, heartbeat?: () => Promise<void>): Promise<{ archive?: string; objectKey?: string; fileName: string }>
  exists(id: string): Promise<unknown>
}

/** Password lives only in the in-flight export. Redis stores metadata and the encrypted archive. */
export class MobileBackupTasks {
  constructor(private readonly deps: Dependencies, private readonly prefix = PREFIX) {}
  async start(deviceId: string, body: any) {
    validateBackupPassword(body?.password)
    if (body.confirmSuspend !== true || !['complete', 'credentials'].includes(body.mode) || Object.keys(body).some(k => !['password', 'confirmSuspend', 'mode'].includes(k))) throw new MobileDeviceError(400, 'mobile_backup_confirmation_required')
    await this.deps.exists(deviceId)
    const task: BackupTask = { id: randomUUID(), deviceId, status: 'running', createdAt: Date.now(), expiresAt: Date.now() + RETENTION * 1000 }
    const accepted = await this.deps.redis.eval(`
      if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
      redis.call('DEL', KEYS[3])
      return 1`, { keys: [LOCK, this.prefix + deviceId, this.prefix + deviceId + ':file'], arguments: [task.id, JSON.stringify(task), String(RUN_MS), String(RETENTION)] })
    if (Number(accepted) !== 1) throw new MobileDeviceError(409, 'mobile_backup_busy')
    // Independent of the HTTP response / browser lifecycle; interruption is surfaced on subsequent reads.
    void this.execute(task, body).catch(() => { /* No secrets or raw storage exceptions logged. Stale task becomes interrupted. */ })
    return task
  }
  private async execute(task: BackupTask, body: any) {
    let file = ''
    try {
      const heartbeat = async () => {
        task.updatedAt = Date.now()
        const result = await this.deps.redis.eval(`if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],ARGV[3]); redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4]); return 1`,
          { keys: [LOCK, this.prefix + task.deviceId], arguments: [task.id, JSON.stringify(task), String(RUN_MS), String(RETENTION)] })
        if (Number(result) !== 1) throw new MobileDeviceError(409, 'session_backup_task_lost')
      }
      file = JSON.stringify({ taskId: task.id, result: await this.deps.export(task.deviceId, body, heartbeat) })
      task.status = 'ready'
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof MobileDeviceError ? error.code : 'mobile_backup_failed'
    }
    task.expiresAt = Date.now() + RETENTION * 1000
    await this.deps.redis.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local raw = redis.call('GET', KEYS[2])
      if not raw or cjson.decode(raw).id ~= ARGV[1] then return 0 end
      if ARGV[3] ~= '' then redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4]) end
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
      redis.call('DEL', KEYS[1])
      return 1`, { keys: [LOCK, this.prefix + task.deviceId, this.prefix + task.deviceId + ':file'], arguments: [task.id, JSON.stringify(task), file, String(RETENTION)] })
  }
  async status(deviceId: string): Promise<BackupTask | undefined> {
    const raw = await this.deps.redis.get(this.prefix + deviceId)
    if (!raw) return undefined
    const task: BackupTask = JSON.parse(raw)
    if (task.status === 'running' && Date.now() - (task.updatedAt || task.createdAt) >= RUN_MS) task.status = 'interrupted'
    return task
  }
  async download(deviceId: string, taskId: string) {
    const state = await this.status(deviceId)
    if (state?.status !== 'ready' || state.id !== taskId) throw new MobileDeviceError(409, 'mobile_backup_not_ready')
    const raw = await this.deps.redis.get(this.prefix + deviceId + ':file')
    if (!raw) throw new MobileDeviceError(410, 'mobile_backup_expired')
    const file = JSON.parse(raw)
    if (file.taskId !== taskId) throw new MobileDeviceError(409, 'mobile_backup_not_ready')
    return file.result as { archive?: string; objectKey?: string; fileName: string }
  }
}

export async function createMobileBackupTasks() {
  const { getRedis } = await import('../redis.js')
  const { createMobileBackupService } = await import('./backup_runtime.js')
  const { MobileDeviceService } = await import('../mobile_device_service.js')
  return new MobileBackupTasks({ redis: await getRedis(), exists: id => new MobileDeviceService().get(id), export: async (id, body) => (await createMobileBackupService()).export(id, body) })
}
