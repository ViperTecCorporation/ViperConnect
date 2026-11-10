import type { WaAuthCredentials } from 'zapo-js/auth'
import type { WaAuthStore } from 'zapo-js/store'
import { MobileDeviceError, type MobileDeviceDraft } from '../mobile_device_service'
import { convertWhalibmobCredentials } from './whalibmob_credentials'
import { registrationSessionPhone } from './registration_identity'
import { primarySourceIdentity, primaryStorageSelection, samePrimaryAuthIdentity, type PrimaryActivation, type PrimaryAuthMutation } from './primary_bootstrap'

export interface MobileConnectionDependencies {
  enabled(): boolean
  draft(id: string): Promise<MobileDeviceDraft>
  registration(id: string): Promise<any>
  config(phone: string): Promise<any>
  saveConfig(phone: string, value: any): Promise<unknown>
  prepareStorage?(phone: string, draftId: string, draft: MobileDeviceDraft): Promise<void>
  assertStorageReady?(phone: string, draftId: string): Promise<void>
  auth(phone: string, mutation?: PrimaryAuthMutation): Promise<WaAuthStore>
  activate?(phone: string, expected: PrimaryActivation, fence: PrimaryAuthMutation['fence']): Promise<void>
  status(phone: string): Promise<string | undefined>
  dispatch(phone: string): Promise<void>
  lease(phone: string): { acquire(): Promise<boolean>; renew(): Promise<boolean>; release(): Promise<unknown>; ownership?(): { key: string; token: string } }
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
    return { draft, state, phone: registrationSessionPhone(state, draft.phone) }
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
    const converted = await convertWhalibmobCredentials(state.store, { expectedCanonicalPhone: state.canonicalPhone, advSecretKey: Buffer.from(state.advSecret, 'base64') })
    const preliminary = await this.deps.config(phone)
    if (preliminary && (preliminary.mobilePrimaryDraftId !== id || preliminary.provider !== 'zapo' || preliminary.server !== this.deps.server)) throw new MobileDeviceError(409, 'mobile_session_conflict')
    // Owner provisioning has its own socket/task reservation. Never wait for it
    // while holding the very socket lease the owner needs to select a backend.
    if ((!preliminary || preliminary.sessionStorageProvisionPending) && this.deps.prepareStorage) await this.deps.prepareStorage(phone, id, draft)
    const lease = this.deps.lease(phone)
    if (!await lease.acquire()) {
      const current = await this.deps.config(phone)
      if (current?.mobilePrimaryDraftId === id && current.mobilePrimaryImported && current.provider === 'zapo' && current.server === this.deps.server && await this.deps.status(phone) === 'online') return { phone, imported: true, status: 'online' }
      throw new MobileDeviceError(409, 'mobile_session_in_use')
    }
    let lost = false
    const timer = setInterval(() => { void lease.renew().then(ok => { if (!ok) lost = true }, () => { lost = true }) }, 15000); timer.unref?.()
    const owned = async () => { if (lost || !await lease.renew()) throw new MobileDeviceError(409, 'mobile_session_in_use') }
    try {
      // Deletion can mark the draft while this import waits for socket ownership.
      await this.deps.draft(id)
      let config = await this.deps.config(phone)
      if (config && (config.mobilePrimaryDraftId !== id || config.provider !== 'zapo' || config.server !== this.deps.server)) throw new MobileDeviceError(409, 'mobile_session_conflict')
      if (this.deps.prepareStorage && (!config || config.sessionStorageProvisionPending)) throw new MobileDeviceError(409, 'session_storage_provision_unconfirmed')
      await this.deps.assertStorageReady?.(phone, id)
      const selected = this.deps.assertStorageReady ? primaryStorageSelection(config, id) : undefined
      const mutation = selected && lease.ownership ? { draftId: id, fence: lease.ownership(), selection: selected } : undefined
      const revalidate = async () => {
        await owned()
        const freshDraft = await this.deps.draft(id), registration = await this.deps.registration(id), current = await this.deps.config(phone)
        if (freshDraft.state === 'deleting' || primarySourceIdentity(freshDraft, registration) !== primarySourceIdentity(draft, state)) throw new MobileDeviceError(409, 'mobile_registration_state_conflict')
        if (!current || current.mobilePrimaryDraftId !== id || current.provider !== 'zapo' || current.server !== this.deps.server || current.mobilePrimaryDeleting) throw new MobileDeviceError(409, 'mobile_session_conflict')
        if (selected && JSON.stringify(primaryStorageSelection(current, id)) !== JSON.stringify(selected)) throw new MobileDeviceError(409, 'mobile_storage_selection_invalid')
        return current
      }
      if (selected) await revalidate()
      const auth = mutation ? await this.deps.auth(phone, mutation) : await this.deps.auth(phone)
      const existing = await auth.load()
      if (existing && !this.sameIdentity(existing, converted)) throw new MobileDeviceError(409, 'mobile_auth_conflict')
      if (!existing && config?.mobilePrimaryImported) throw new MobileDeviceError(409, 'mobile_auth_removed_registration_required')
      await owned()
      if (!config) await this.deps.saveConfig(phone, { provider: 'zapo', server: this.deps.server, name: draft.name, autoConnect: false, webhooks: [], markOnlineOnConnect: false, mobilePrimaryDraftId: id })
      if (!existing) { if (selected) await revalidate(); await auth.save(converted) }
      await owned()
      if (selected) {
        const confirmed = await auth.load()
        if (!confirmed || !this.sameIdentity(confirmed, converted)) throw new MobileDeviceError(409, 'mobile_auth_import_unconfirmed')
        config = await revalidate()
      }
      if (!config?.mobilePrimaryImported || !config.autoConnect) {
        if (this.deps.activate && mutation) await this.deps.activate(phone, { config, draft, registration: state }, mutation.fence)
        else await this.deps.saveConfig(phone, { mobilePrimaryImported: true, autoConnect: true })
      }
    } finally { clearInterval(timer); await lease.release() }
    // The reload notification never carries credentials. SQLite auth import uses
    // the private owner RPC; Zapo recognizes deviceInfo from persisted auth.
    await this.deps.dispatch(phone)
    return { phone, imported: true, status: 'connection_requested' }
  }

  private sameIdentity(a: WaAuthCredentials, b: WaAuthCredentials): boolean {
    return samePrimaryAuthIdentity(a, b)
  }
}
