import { MobileDeviceDraft, MobileDeviceError, MOBILE_DRAFTS_KEY } from '../mobile_device_service'
import { REGISTRATION_PREFIX } from './registration_service'

export const MARK_MOBILE_DELETING = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`
export const FINISH_MOBILE_DELETION = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[2])
if KEYS[3] then redis.call('DEL', KEYS[3]) end
if KEYS[4] then redis.call('DEL', KEYS[4]) end
if KEYS[5] then redis.call('DEL', KEYS[5]) end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1`

interface Lease { acquire(): Promise<boolean>; renew(): Promise<boolean>; release(): Promise<unknown> }
export interface MobileDeletionDependencies {
  list(): Promise<MobileDeviceDraft[]>
  registration(id: string): Promise<{ canonicalPhone?: string } | undefined>
  config(phone: string): Promise<any>
  saveConfig(phone: string, value: any): Promise<unknown>
  dispatch(phone: string): Promise<void>
  clear(phone: string, config: any): Promise<void>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  lease(name: string): Lease
  pause(): Promise<void>
  backupCompleted?(phone: string, id: string): Promise<boolean>
}

/** Destructive local deletion; never invokes WhatsApp account deletion or logout. */
export class MobileDeletionService {
  constructor(private readonly deps: MobileDeletionDependencies) {}
  async transferEligibility(id: string) {
    const draft = (await this.deps.list()).find(item => item.id === id)
    if (!draft) throw new MobileDeviceError(404, 'mobile_draft_not_found')
    const phone = (await this.deps.registration(id))?.canonicalPhone || draft.phone
    return { eligible: await this.transferReady(id, phone, await this.deps.config(phone)) }
  }
  private async transferReady(id: string, phone: string, config: any) {
    return !!(config?.mobilePrimaryDraftId === id && config?.mobilePrimaryImported === true && config?.autoConnect === false && await this.deps.backupCompleted?.(phone, id))
  }
  async remove(id: string, body: any, transferred = false) {
    if (body && typeof body.phone === 'string') body = { ...body, phone: body.phone.trim() }
    const consent = transferred ? 'backupValidated' : 'acknowledgeNewSms'
    if (!body || body.confirm !== true || body[consent] !== true || typeof body.phone !== 'string' || Object.keys(body).some(key => !['confirm', consent, 'phone'].includes(key))) throw new MobileDeviceError(400, 'mobile_full_removal_confirmation_required')
    const draft = (await this.deps.list()).find(item => item.id === id)
    if (!draft) throw new MobileDeviceError(404, 'mobile_draft_not_found')
    if (body.phone !== draft.phone) throw new MobileDeviceError(400, 'mobile_removal_phone_mismatch')
    const operation = this.deps.lease(`mobile-delete:${id}`)
    if (!await operation.acquire()) throw new MobileDeviceError(409, 'mobile_deletion_busy')
    let ownership: Lease | undefined
    let acquired = false
    try {
      const registration = await this.deps.registration(id)
      const phone = registration?.canonicalPhone || draft.phone
      if (!/^[1-9]\d{7,14}$/.test(phone)) throw new MobileDeviceError(409, 'mobile_deletion_identity_invalid')
      const config = await this.deps.config(phone)
      if (config && config.mobilePrimaryDraftId !== id) throw new MobileDeviceError(409, 'mobile_session_conflict')
      if (transferred && !await this.transferReady(id, phone, config)) throw new MobileDeviceError(409, 'mobile_transfer_backup_suspension_required')
      const deleting = { ...draft, state: 'deleting' as const }
      const snapshot = JSON.stringify(deleting)
      if (Number(await this.deps.eval(MARK_MOBILE_DELETING, { keys: [MOBILE_DRAFTS_KEY], arguments: [draft.phone, JSON.stringify(draft), snapshot] })) !== 1) throw new MobileDeviceError(409, 'mobile_draft_changed')
      // The changed draft blocks new registration/import and invalidates pending SMS CAS.
      if (config) {
        await this.deps.saveConfig(phone, { autoConnect: false, mobilePrimaryDeleting: true })
        if (!transferred) await this.deps.dispatch(phone)
      }
      ownership = this.deps.lease(`zapo-session:${phone}`)
      for (let attempt = 0; attempt < 50; attempt++) {
        acquired = await ownership.acquire()
        if (acquired) break
        await this.deps.pause()
      }
      if (!acquired) throw new MobileDeviceError(409, 'mobile_deletion_waiting_disconnect')
      if (!await operation.renew() || !await ownership.renew()) throw new MobileDeviceError(409, 'mobile_deletion_busy')
      const latest = await this.deps.config(phone)
      if (latest && latest.mobilePrimaryDraftId !== id) throw new MobileDeviceError(409, 'mobile_session_conflict')
      if (transferred && !await this.transferReady(id, phone, latest)) throw new MobileDeviceError(409, 'mobile_transfer_backup_suspension_required')
      if (latest) await this.deps.clear(phone, latest)
      if (Number(await this.deps.eval(FINISH_MOBILE_DELETION, { keys: [MOBILE_DRAFTS_KEY, REGISTRATION_PREFIX + id, `mobile-primary:{v1}:companions:${id}`, `mobile-primary:{v1}:companion-operation:${id}`, `mobile-primary:{v1}:backup-completed:${phone}`], arguments: [draft.phone, snapshot] })) !== 1) throw new MobileDeviceError(409, 'mobile_draft_changed')
    } finally {
      try { if (acquired) await ownership?.release() } finally { await operation.release() }
    }
  }
}
