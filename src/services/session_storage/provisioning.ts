import { randomUUID } from 'node:crypto'
import { getRedis } from '../redis'
import { SessionStorageError, validateSessionPhone, validateStorageDescriptor } from './types'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export interface ProvisionPending { id: string; autoConnect: boolean }
export interface ProvisionReceipt { id: string; backend: 'redis' | 'sqlite'; owner: string; generation: number; storageId?: string }

export function createProvisionPending(autoConnect: boolean): ProvisionPending {
  if (typeof autoConnect !== 'boolean') throw new SessionStorageError(400, 'session_storage_auto_connect_invalid')
  return { id: randomUUID(), autoConnect }
}

export function assertProvisionPending(config: any, id: string, owner: string): asserts id is string {
  if (!uuid.test(id || '') || config?.provider !== 'zapo' || config.server !== owner || config.autoConnect !== false
    || config.sessionStorageProvisionPending?.id !== id || typeof config.sessionStorageProvisionPending.autoConnect !== 'boolean'
    || config.sessionStorage?.fixture || config.mobilePrimaryDeleting || ['migrating', 'restoring'].includes(config.sessionStorage?.state)) {
    throw new SessionStorageError(409, 'session_storage_provision_changed')
  }
}

export function confirmedProvisionReceipt(config: any, id: string, owner: string): ProvisionReceipt {
  const receipt = config?.sessionStorageProvisioned, storage = config?.sessionStorage
  if (storage) {
    try { validateStorageDescriptor(storage) } catch { throw new SessionStorageError(409, 'session_storage_provision_unconfirmed') }
  }
  if (!uuid.test(id || '') || config?.provider !== 'zapo' || config.server !== owner || !receipt || receipt.id !== id || receipt.owner !== owner
    || !['redis', 'sqlite'].includes(receipt.backend) || config.mobilePrimaryDeleting || storage?.fixture || ['migrating', 'restoring'].includes(storage?.state)
    || receipt.backend === 'redis' && (storage || receipt.generation !== 0 || receipt.storageId !== undefined)
    || receipt.backend === 'sqlite' && (!storage || storage.backend !== 'sqlite' || storage.owner !== owner || receipt.storageId !== storage.storageId || receipt.generation !== storage.generation)) {
    throw new SessionStorageError(409, 'session_storage_provision_unconfirmed')
  }
  return { id: receipt.id, backend: receipt.backend, owner: receipt.owner, generation: receipt.generation,
    ...(receipt.storageId ? { storageId: receipt.storageId } : {}) }
}

// Both operations compare the exact raw configuration, including destination,
// owner, intent, pending ID and storage generation. No reply alone enables a socket.
export const RECORD_PROVISION_LUA = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local cfg=cjson.decode(ARGV[1]); local p=cfg.sessionStorageProvisionPending
if type(p)~='table' or p.id~=ARGV[2] or cfg.autoConnect~=false or cfg.provider~='zapo' or cfg.server~=ARGV[3] then return 0 end
cfg.sessionStorageProvisioned=cjson.decode(ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('PUBLISH','unoapi-config:update',ARGV[5]); return 1`
export const CONFIRM_PROVISION_LUA = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local cfg=cjson.decode(ARGV[1]); local p=cfg.sessionStorageProvisionPending; local r=cfg.sessionStorageProvisioned
if type(p)~='table' or p.id~=ARGV[2] or type(r)~='table' or r.id~=ARGV[2] or r.owner~=ARGV[3] or cfg.autoConnect~=false then return 0 end
cfg.autoConnect=p.autoConnect; cfg.sessionStorageProvisionPending=cjson.null
redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('PUBLISH','unoapi-config:update',ARGV[4]); return 1`

export async function recordProvisionReceipt(phone: string, raw: string, receipt: ProvisionReceipt) {
  validateSessionPhone(phone)
  assertProvisionPending(JSON.parse(raw), receipt.id, receipt.owner)
  const next = { ...JSON.parse(raw), sessionStorageProvisioned: receipt }
  confirmedProvisionReceipt(next, receipt.id, receipt.owner)
  if (Number(await (await getRedis()).eval(RECORD_PROVISION_LUA, { keys: [`unoapi-config:${phone}`],
    arguments: [raw, receipt.id, receipt.owner, JSON.stringify(receipt), phone] })) !== 1) throw new SessionStorageError(409, 'session_storage_provision_changed')
  return receipt
}

/** Shared QR/Primary completion. Lost RPC replies may use the durable receipt,
 * but a concurrent config edit, different attempt or owner is never adopted. */
export async function confirmSessionStorageProvision(phone: string, id: string, owner: string, expectedBackend?: 'redis' | 'sqlite'): Promise<ProvisionReceipt> {
  validateSessionPhone(phone)
  const redis = await getRedis(), raw = await redis.get(`unoapi-config:${phone}`)
  if (!raw) throw new SessionStorageError(409, 'session_storage_provision_unconfirmed')
  const config = JSON.parse(raw), receipt = confirmedProvisionReceipt(config, id, owner)
  if (expectedBackend !== undefined && receipt.backend !== expectedBackend) throw new SessionStorageError(409, 'session_storage_provision_unconfirmed')
  if (config.sessionStorageProvisionPending == null) return receipt
  assertProvisionPending(config, id, owner)
  if (Number(await redis.eval(CONFIRM_PROVISION_LUA, { keys: [`unoapi-config:${phone}`], arguments: [raw, id, owner, phone] })) !== 1) {
    throw new SessionStorageError(409, 'session_storage_provision_changed')
  }
  return receipt
}
