import type { WaClient } from 'zapo-js'
import { SendError } from '../send_error'
import { ProfileCommand } from '../profile_input'
import { privacyValues, privacyExceptions, validatePrivacyInput } from '../profile_privacy_input'

export class ZapoOwnPrivacy {
  constructor(private readonly client: WaClient) {}
  async execute(command: ProfileCommand) {
    const privacy = this.client.privacy
    if (!privacy) throw new SendError(501, 'profile_privacy_capability_unavailable')
    if (command.action === 'get') {
      const warnings: string[] = []
      const read = async (key: string, fn: () => Promise<any>) => { try { return await fn() } catch { warnings.push(key); return null } }
      const [raw, blocked, timer, ...lists] = await Promise.all([
        read('settings', () => privacy.getPrivacySettings()),
        read('blocked', () => privacy.getBlocklist()),
        read('timer', () => this.client.profile.getDisappearingMode([this.client.getCredentials()!.meJid!.replace(/:\d+@/, '@')])),
        ...privacyExceptions.map(setting => read(`exceptions.${setting}`, () => privacy.getDisallowedList(setting as any))),
      ])
      const settings = raw === null ? null : Object.fromEntries(Object.entries(raw).filter(([key, value]) => Object.prototype.hasOwnProperty.call(privacyValues, key) && privacyValues[key].includes(value as string)))
      return { settings, blocked: blocked?.jids ?? null, duration: timer?.[0]?.duration ?? null,
        exceptions: Object.fromEntries(privacyExceptions.map((key, i) => [key, lists[i]?.jids ?? null])), warnings }
    }
    validatePrivacyInput(command.value)
    const v = command.value
    if (v.operation === 'status' && !this.client.status?.setPrivacy) throw new SendError(501, 'profile_status_privacy_capability_unavailable')
    try {
      if (v.operation === 'status') await this.client.status.setPrivacy({ mode: v.mode,
        userJids: [...new Set<string>(v.userJids.map((jid: string) => jid.includes('@') ? jid : `${jid}@s.whatsapp.net`))] })
      if (v.operation === 'setting') await privacy.setPrivacySetting(v.setting, v.value)
      if (v.operation === 'exceptions') await privacy.setDisallowedList(v.setting, { add: v.add, remove: v.remove })
      if (v.operation === 'block') await privacy.blockUser(v.jid)
      if (v.operation === 'unblock') await privacy.unblockUser(v.jid)
      if (v.operation === 'timer') await this.client.profile.setDisappearingMode(v.duration)
      return { success: true }
    } catch {
      throw new SendError(502, 'profile_privacy_update_failed_consult_before_retry')
    }
  }
}
