import { randomUUID } from 'node:crypto'
import { SessionStorageDescriptor, SessionStorageError, SessionStorageRedis, validateSessionPhone, validateStorageDescriptor } from './types'

export interface BackupWindowReservation { token: string; window: number; startedAt: number }
export interface BackupScheduleStatus {
  phase: 'running' | 'ready' | 'failed'; window: number; updatedAt: number
  lastSuccess?: { at: number; window: number }
  lastError?: { at: number; window: number; code: string }
}
const BACKUP_LEASE_MS = 120000
const scheduleKey = (phone: string) => `unoapi-session-storage:backup-schedule:${phone}`
const backupLockKey = (phone: string) => `unoapi-session-storage:backup-scheduler-lock:${phone}`
const backupWindowKey = (phone: string, window: number) => `unoapi-session-storage:backup-window:${phone}:${window}`
const backupWindow = (now: number) => {
  if (!Number.isSafeInteger(now) || now < 0) throw new SessionStorageError(400, 'session_storage_window_invalid')
  return Math.floor(now / 43200000)
}
const safeBackupError = (code: unknown) => typeof code === 'string' && /^session_storage_[a-z0-9_]{1,100}$/.test(code) ? code : 'session_storage_backup_failed'

export const RESERVE_BACKUP_WINDOW_LUA = `
if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end
redis.call('SET',KEYS[2],ARGV[1],'PX',ARGV[3])
local raw=redis.call('GET',KEYS[3]); local status=raw and cjson.decode(raw) or {}
status.phase='running'; status.window=tonumber(ARGV[4]); status.updatedAt=tonumber(ARGV[2])
redis.call('SET',KEYS[3],cjson.encode(status)); return 1`

export const FINISH_BACKUP_WINDOW_LUA = `
if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
local raw=redis.call('GET',KEYS[3]); local status=raw and cjson.decode(raw) or {}
status.window=tonumber(ARGV[3]); status.updatedAt=tonumber(ARGV[2])
if ARGV[4]=='true' then
 redis.call('SET',KEYS[1],ARGV[2],'EX',259200)
 status.phase='ready'; status.lastSuccess={at=tonumber(ARGV[2]),window=tonumber(ARGV[3])}
else
 status.phase='failed'; status.lastError={at=tonumber(ARGV[2]),window=tonumber(ARGV[3]),code=ARGV[5]}
end
redis.call('SET',KEYS[3],cjson.encode(status)); redis.call('DEL',KEYS[2]); return 1`

export const STORAGE_CAS_LUA = `
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local cfg=cjson.decode(raw); local old=cfg.sessionStorage
if old==cjson.null then old=nil end
local generation=old and old.generation or 0
local backend=old and old.backend or 'redis'
if generation~=tonumber(ARGV[1]) or backend~=ARGV[2] then return 0 end
if ARGV[4]~='' and cfg.sessionStorageTaskId~=ARGV[4] then return 0 end
local next=cjson.decode(ARGV[3]); local owner=old and old.owner or cfg.server
if owner and owner~=next.owner then return 0 end
local provisionId=ARGV[8] or ''
if provisionId~='' then
 local p=cfg.sessionStorageProvisionPending
 if type(p)~='table' or p.id~=provisionId or cfg.provider~='zapo' or cfg.autoConnect~=false or cfg.server~=next.owner then return 0 end
 cfg.sessionStorageProvisioned={id=provisionId,backend=next.backend,owner=next.owner,storageId=next.storageId,generation=next.generation}
end
cfg.sessionStorage=next
if ARGV[5]~='' then cfg.sessionStorageTaskId=ARGV[5] else cfg.sessionStorageTaskId=nil end
if ARGV[6]~='' then cfg.autoConnect=cjson.decode(ARGV[6]) end
redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('PUBLISH','unoapi-config:update',ARGV[7]); return 1`

export class SessionStorageCatalog {
  constructor(readonly redis: SessionStorageRedis) {}

  async read(phone: string): Promise<SessionStorageDescriptor | undefined> {
    validateSessionPhone(phone)
    const raw = await this.redis.get(`unoapi-config:${phone}`)
    if (!raw) throw new SessionStorageError(404, 'session_storage_session_not_found')
    const descriptor = JSON.parse(raw).sessionStorage
    if (descriptor !== undefined) validateStorageDescriptor(descriptor)
    return descriptor
  }

  async compareAndSet(phone: string, expectedGeneration: number, expectedBackend: 'redis' | 'sqlite', next: SessionStorageDescriptor,
    options: { expectedTaskId?: string; taskId?: string; autoConnect?: boolean; provisionId?: string } = {}) {
    validateSessionPhone(phone); validateStorageDescriptor(next)
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new SessionStorageError(400, 'session_storage_generation_invalid')
    if (next.generation !== expectedGeneration + 1) throw new SessionStorageError(400, 'session_storage_generation_invalid')
    if (options.provisionId && !/^[0-9a-f-]{36}$/i.test(options.provisionId)) throw new SessionStorageError(400, 'session_storage_provision_changed')
    const changed = await this.redis.eval(STORAGE_CAS_LUA, { keys: [`unoapi-config:${phone}`], arguments: [String(expectedGeneration), expectedBackend, JSON.stringify(next), options.expectedTaskId || '', options.taskId || '', options.autoConnect === undefined ? '' : JSON.stringify(options.autoConnect), phone, options.provisionId || ''] })
    if (Number(changed) !== 1) throw new SessionStorageError(409, 'session_storage_configuration_changed')
    return next
  }

  /** Durable recovery metadata. Paths and secrets must stay in the worker, not this journal. */
  async journal(phone: string, taskId: string, entry: { phase: string; generation: number; storageId: string }) {
    validateSessionPhone(phone)
    if (!/^[0-9a-f-]{36}$/i.test(taskId) || !/^[0-9a-f-]{36}$/i.test(entry.storageId) || !/^[a-z_]{1,60}$/.test(entry.phase)) throw new SessionStorageError(400, 'session_storage_journal_invalid')
    await this.redis.eval("redis.call('SET',KEYS[1],ARGV[1]); return 1", { keys: [`unoapi-session-storage:journal:${phone}:${taskId}`], arguments: [JSON.stringify({ ...entry, taskId, phone, updatedAt: Date.now() })] })
  }

  /** Legacy completed-window marker. New schedulers reserve/finish, never claim before upload. */
  async claimBackupWindow(phone: string, now = Date.now()) {
    validateSessionPhone(phone)
    if (!Number.isFinite(now) || now < 0) throw new SessionStorageError(400, 'session_storage_window_invalid')
    const window = Math.floor(now / 43200000)
    return Number(await this.redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'EX',259200); return 1", { keys: [`unoapi-session-storage:backup-window:${phone}:${window}`], arguments: [String(now)] })) === 1
  }

  /** Renewable reservation, not a success marker. Failed attempts may retry in the same window. */
  async reserveBackupWindow(phone: string, now = Date.now()): Promise<BackupWindowReservation | undefined> {
    validateSessionPhone(phone)
    const window = backupWindow(now), token = randomUUID()
    const result = await this.redis.eval(RESERVE_BACKUP_WINDOW_LUA, { keys: [backupWindowKey(phone, window), backupLockKey(phone), scheduleKey(phone)], arguments: [token, String(now), String(BACKUP_LEASE_MS), String(window)] })
    return Number(result) === 1 ? { token, window, startedAt: now } : undefined
  }

  async renewBackupWindow(phone: string, reservation: BackupWindowReservation) {
    validateSessionPhone(phone); this.validateReservation(reservation)
    return Number(await this.redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 1", { keys: [backupLockKey(phone)], arguments: [reservation.token, String(BACKUP_LEASE_MS)] })) === 1
  }

  async finishBackupWindow(phone: string, reservation: BackupWindowReservation, success: boolean, code?: string, now = Date.now()) {
    validateSessionPhone(phone); this.validateReservation(reservation); backupWindow(now)
    return Number(await this.redis.eval(FINISH_BACKUP_WINDOW_LUA, { keys: [backupWindowKey(phone, reservation.window), backupLockKey(phone), scheduleKey(phone)], arguments: [reservation.token, String(now), String(reservation.window), String(success), safeBackupError(code)] })) === 1
  }

  /** Public receipt only: never expose lease tokens, paths, credentials or raw exception messages. */
  async backupScheduleStatus(phone: string): Promise<BackupScheduleStatus | undefined> {
    validateSessionPhone(phone)
    const raw = await this.redis.get(scheduleKey(phone)); if (!raw) return undefined
    let value: any
    try { value = JSON.parse(raw) } catch { throw new SessionStorageError(503, 'session_storage_backup_schedule_invalid') }
    if (!['running', 'ready', 'failed'].includes(value?.phase) || !Number.isSafeInteger(value.window) || value.window < 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new SessionStorageError(503, 'session_storage_backup_schedule_invalid')
    const stamp = (item: any) => item && Number.isSafeInteger(item.at) && item.at >= 0 && Number.isSafeInteger(item.window) && item.window >= 0 ? { at: item.at, window: item.window } : undefined
    const success = stamp(value.lastSuccess), error = stamp(value.lastError)
    return { phase: value.phase, window: value.window, updatedAt: value.updatedAt, ...(success ? { lastSuccess: success } : {}), ...(error ? { lastError: { ...error, code: safeBackupError(value.lastError.code) } } : {}) }
  }

  private validateReservation(value: BackupWindowReservation) {
    if (!value || !/^[0-9a-f-]{36}$/i.test(value.token) || !Number.isSafeInteger(value.window) || value.window < 0 || backupWindow(value.startedAt) !== value.window) throw new SessionStorageError(400, 'session_storage_backup_reservation_invalid')
  }
}
