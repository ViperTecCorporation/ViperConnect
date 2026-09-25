import { randomUUID } from 'node:crypto'
import { MobileDeviceError } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import logger from '../logger'

export const companionOperationKey = (id: string) => `mobile-primary:{v1}:companion-operation:${id}`
export const COMPANION_CAS = `
if (redis.call('GET',KEYS[1]) or '') ~= ARGV[1] then return 0 end
if #KEYS > 1 and redis.call('GET',KEYS[2]) ~= ARGV[3] then return 0 end
redis.call('SET',KEYS[1],ARGV[2],'EX',600)
return 1`
interface Redis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export type CompanionCommand = { action: 'list' | 'qr' | 'code' | 'revoke'; value?: string }
interface Operation extends CompanionCommand {
  id: string; state: 'queued' | 'running' | 'done' | 'unknown' | 'expired'
  createdAt: number; result?: unknown
}
export interface CompanionMobile {
  listCompanions(): Promise<readonly { deviceJid: string; keyIndex: number; addedAtSeconds: number }[]>
  linkCompanion(qr: string): Promise<{ deviceJid: string; keyIndex: number }>
  linkCompanionByCode(code: string): Promise<{ deviceJid: string; keyIndex: number }>
  revokeCompanion(jid: string): Promise<void>
}
export function validateCompanionCommand(body: any): CompanionCommand {
  if (!body || !['list', 'qr', 'code', 'revoke'].includes(body.action) || Object.keys(body).some(k => !['action', 'value', 'confirm'].includes(k))) throw new MobileDeviceError(400, 'mobile_companion_command_invalid')
  if (body.action !== 'list' && body.confirm !== true) throw new MobileDeviceError(400, 'mobile_companion_confirmation_required')
  const value = typeof body.value === 'string' ? body.value.trim() : ''
  if (body.action === 'qr') {
    const parts = value.split(',')
    const keys = parts.slice(-4, -1)
    if (!value || value.length > 4096 || parts.length < 5 || !parts.slice(0, -4).join(',') || !parts[parts.length - 1]
      || keys.some((key, index) => !/^[A-Za-z0-9+/_-]+={0,2}$/.test(key) || ![32, ...(index < 2 ? [33] : [])].includes(Buffer.from(key, 'base64').length))) throw new MobileDeviceError(400, 'mobile_companion_qr_invalid')
  }
  if (body.action === 'code' && !/^[A-Z0-9]{8}$/.test(value)) throw new MobileDeviceError(400, 'mobile_companion_code_invalid')
  if (body.action === 'revoke' && !/^\d+:\d+@s\.whatsapp\.net$/.test(value)) throw new MobileDeviceError(400, 'mobile_companion_jid_invalid')
  return { action: body.action, ...(body.action === 'list' ? {} : { value }) }
}

/** One encrypted, expiring command per device. Never redeliver a claimed mutation.
 * The web process never opens a WhatsApp socket. The current worker owns execution.
 */
export class MobileCompanionOperations {
  private readonly key: string
  constructor(private redis: Redis, private vault: RegistrationVault, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new MobileDeviceError(400, 'mobile_companion_scope_invalid')
    this.key = companionOperationKey(id)
  }
  private decode(raw: string): Operation { return this.vault.open<Operation>(this.key, raw) }
  private async replace(previous: string, next: Operation, fence?: { key: string; token: string }) {
    const encoded = this.vault.seal(this.key, next)
    const ok = await this.redis.eval(COMPANION_CAS, { keys: [this.key, ...(fence ? [fence.key] : [])], arguments: [previous, encoded, fence?.token || ''] })
    return Number(ok) === 1 ? encoded : undefined
  }
  async submit(body: unknown) {
    const command = validateCompanionCommand(body)
    const raw = await this.redis.get(this.key)
    const previous = raw ? this.decode(raw) : undefined
    if (previous && ['queued', 'running'].includes(previous.state) && Date.now() - previous.createdAt < 180000) throw new MobileDeviceError(409, 'mobile_companion_busy')
    if (previous && ['running', 'unknown'].includes(previous.state) && command.action !== 'list') throw new MobileDeviceError(409, 'mobile_companion_refresh_required')
    const operation: Operation = { ...command, id: randomUUID(), state: 'queued', createdAt: Date.now() }
    if (!await this.replace(raw || '', operation)) throw new MobileDeviceError(409, 'mobile_companion_busy')
    return { id: operation.id, state: operation.state }
  }
  async status(id: string) {
    const raw = await this.redis.get(this.key)
    if (!raw) throw new MobileDeviceError(404, 'mobile_companion_operation_expired')
    const operation = this.decode(raw)
    if (operation.id !== id) throw new MobileDeviceError(404, 'mobile_companion_operation_expired')
    const state = Date.now() - operation.createdAt > 180000 && ['running', 'queued'].includes(operation.state)
      ? operation.state === 'running' ? 'unknown' : 'expired' : operation.state
    // QR, pairing codes, identity keys and raw provider errors never leave the vault.
    return { id, state, ...(operation.result ? { result: operation.result } : {}) }
  }
  async tick(mobile: CompanionMobile, fence: { key: string; token: string }, current: () => boolean) {
    if (!current()) return
    const raw = await this.redis.get(this.key)
    if (!raw || !current()) return
    const operation = this.decode(raw)
    if (operation.state !== 'queued') return
    if (Date.now() - operation.createdAt > 60000) {
      await this.replace(raw, { ...operation, value: undefined, state: 'expired' }, fence)
      return
    }
    const claimed = await this.replace(raw, { ...operation, state: 'running' }, fence)
    if (!claimed) return
    let result: unknown, state: Operation['state'] = 'done'
    try {
      if (!current()) throw new Error('worker_changed')
      if (operation.action === 'list') result = { companions: (await mobile.listCompanions()).map(({ deviceJid, keyIndex, addedAtSeconds }) => ({ deviceJid, keyIndex, addedAtSeconds })), source: 'persisted_epoch' }
      else if (operation.action === 'qr') result = await mobile.linkCompanion(operation.value!)
      else if (operation.action === 'code') result = await mobile.linkCompanionByCode(operation.value!)
      else {
        if (!(await mobile.listCompanions()).some(item => item.deviceJid === operation.value)) throw new Error('not_linked')
        await mobile.revokeCompanion(operation.value!)
        result = { revoked: true }
      }
    } catch {
      state = 'unknown'
      logger.warn({ operationId: operation.id, action: operation.action }, 'MOBILE_COMPANION_RESULT_UNKNOWN')
    }
    if (current()) await this.replace(claimed, { ...operation, value: undefined, state, result }, fence)
  }
}

/** Separate asynchronous lane: a slow pairing operation never occupies incoming jobs. */
export function startCompanionWorker(operations: MobileCompanionOperations, mobile: CompanionMobile, fence: { key: string; token: string }, current: () => boolean) {
  let busy = false, stopped = false
  const timer = setInterval(() => {
    if (busy || stopped || !current()) return
    busy = true
    void operations.tick(mobile, fence, () => !stopped && current()).catch(() => undefined).finally(() => { busy = false })
  }, 1000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
