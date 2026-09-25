import type { WaAuthCredentials } from 'zapo-js/auth'
import type { WaAuthStore } from 'zapo-js/store'
import { MobileDeviceError, type MobileDeviceDraft } from '../mobile_device_service'
import { convertWhalibmobCredentials } from './whalibmob_credentials'

export interface MobileConnectionDependencies {
  enabled(): boolean
  draft(id: string): Promise<MobileDeviceDraft>
  registration(id: string): Promise<any>
  config(phone: string): Promise<any>
  saveConfig(phone: string, value: any): Promise<unknown>
  auth(phone: string): Promise<WaAuthStore>
  status(phone: string): Promise<string | undefined>
  dispatch(phone: string): Promise<void>
  lease(phone: string): { acquire(): Promise<boolean>; renew(): Promise<boolean>; release(): Promise<unknown> }
  server: string
}

/** Import once, never replace live auth, and request the existing worker pipeline. */
export class MobileConnectionService {
  constructor(private readonly deps: MobileConnectionDependencies) {}

  private async source(id: string) {
    if (!this.deps.enabled()) throw new MobileDeviceError(404, 'mobile_connection_disabled')
    const draft = await this.deps.draft(id)
    const state = await this.deps.registration(id)
    if (state?.status !== 'registered' || !/^[1-9]\d{7,14}$/.test(state.canonicalPhone || '')) throw new MobileDeviceError(409, 'mobile_registration_required')
    return { draft, state, phone: state.canonicalPhone as string }
  }

  async status(id: string) {
    const { phone } = await this.source(id)
    const config = await this.deps.config(phone)
    if (config && config.mobilePrimaryDraftId !== id) throw new MobileDeviceError(409, 'mobile_session_conflict')
    return { phone, imported: config?.mobilePrimaryImported === true, status: config?.mobilePrimaryImported ? await this.deps.status(phone) || 'disconnected' : 'not_imported' }
  }

  async connect(id: string, input: any) {
    if (!input || input.confirm !== true || Object.keys(input).some(key => key !== 'confirm')) throw new MobileDeviceError(400, 'mobile_connection_confirmation_required')
    const { draft, state, phone } = await this.source(id)
    // Validate before taking ownership or creating a session configuration.
    const converted = await convertWhalibmobCredentials(state.store, { expectedCanonicalPhone: phone, advSecretKey: Buffer.from(state.advSecret, 'base64') })
    const lease = this.deps.lease(phone)
    if (!await lease.acquire()) {
      const current = await this.deps.config(phone)
      if (current?.mobilePrimaryDraftId === id && current.mobilePrimaryImported && current.provider === 'zapo' && current.server === this.deps.server && await this.deps.status(phone) === 'online') return { phone, imported: true, status: 'online' }
      throw new MobileDeviceError(409, 'mobile_session_in_use')
    }
    try {
      // Deletion can mark the draft while this import waits for socket ownership.
      await this.deps.draft(id)
      const config = await this.deps.config(phone)
      if (config && (config.mobilePrimaryDraftId !== id || config.provider !== 'zapo' || config.server !== this.deps.server)) throw new MobileDeviceError(409, 'mobile_session_conflict')
      const auth = await this.deps.auth(phone)
      const existing = await auth.load()
      if (existing && !this.sameIdentity(existing, converted)) throw new MobileDeviceError(409, 'mobile_auth_conflict')
      if (!existing && config?.mobilePrimaryImported) throw new MobileDeviceError(409, 'mobile_auth_removed_registration_required')
      if (!await lease.renew()) throw new MobileDeviceError(409, 'mobile_session_in_use')
      if (!config) await this.deps.saveConfig(phone, { provider: 'zapo', server: this.deps.server, name: draft.name, autoConnect: false, webhooks: [], markOnlineOnConnect: false, mobilePrimaryDraftId: id })
      if (!existing) await auth.save(converted)
      if (!await lease.renew()) throw new MobileDeviceError(409, 'mobile_session_in_use')
      if (!config?.mobilePrimaryImported || !config.autoConnect) await this.deps.saveConfig(phone, { mobilePrimaryImported: true, autoConnect: true })
    } finally { await lease.release() }
    // Credentials never enter the queue; Zapo recognizes deviceInfo from persisted auth.
    await this.deps.dispatch(phone)
    return { phone, imported: true, status: 'connection_requested' }
  }

  private sameIdentity(a: WaAuthCredentials, b: WaAuthCredentials): boolean {
    return a.meJid === b.meJid && a.deviceInfo?.os === b.deviceInfo?.os && a.deviceInfo?.business === b.deviceInfo?.business &&
      Buffer.from(a.noiseKeyPair.pubKey).equals(Buffer.from(b.noiseKeyPair.pubKey)) &&
      Buffer.from(a.registrationInfo.identityKeyPair.pubKey).equals(Buffer.from(b.registrationInfo.identityKeyPair.pubKey))
  }
}
