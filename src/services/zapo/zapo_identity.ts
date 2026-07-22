import type { WaClient, WaStoredContactRecord, WaStoreSession } from 'zapo-js'
import { phoneNumberToJid } from '../transformer/jid'
import { SendError } from '../send_error'
import { zapoUsernameIndex, type ZapoUsernameIndex } from './zapo_username_index'

const isPhoneJid = (value: string) => /^\d+@s\.whatsapp\.net$/.test(value)
const toLidJid = (value?: string | null) => {
  const raw = `${value || ''}`.trim()
  if (!raw) return undefined
  return raw.endsWith('@lid') ? raw : (/^\d+$/.test(raw) ? `${raw}@lid` : undefined)
}

export class ZapoIdentity {
  constructor(
    private readonly client: WaClient,
    private readonly store: WaStoreSession,
    private readonly phone: string,
    private readonly usernames: ZapoUsernameIndex = zapoUsernameIndex,
  ) {}

  normalize(value: string): string {
    const raw = `${value || ''}`.trim()
    if (!raw) throw new Error('recipient cannot be empty')
    return raw.includes('@') ? raw : phoneNumberToJid(raw)
  }

  async resolve(value: string): Promise<string> {
    return (await this.resolveMany([value]))[0]
  }

  async resolveMany(values: readonly string[]): Promise<string[]> {
    const normalized = await Promise.all(values.map(async (value) => {
      const raw = `${value || ''}`.trim()
      if (raw && !raw.includes('@lid') && !raw.includes('@s.whatsapp.net') && /[a-z_]/i.test(raw)) {
        const lid = await this.usernames.resolve(this.phone, raw)
        if (!lid) throw new SendError(404, `zapo_username_lid_not_cached: ${raw.replace(/^@/, '')}`)
        return lid
      }
      return this.normalize(raw)
    }))
    const resolved = [...normalized]
    const unresolved = await Promise.all(normalized.map(async (jid, index) => {
      if (!isPhoneJid(jid)) return
      const phone = jid.split('@')[0]
      const contact = await this.store.contacts.getByPhoneNumber(phone)
        || await this.store.contacts.getByPhoneNumber(jid)
      const lid = toLidJid(contact?.lid) || (contact?.jid?.endsWith('@lid') ? contact.jid : undefined)
      if (lid) resolved[index] = lid
      else return { index, phoneJid: jid }
    }))
    const unknown = unresolved.filter((item): item is { index: number; phoneJid: string } => !!item)

    if (unknown.length) {
      const lookups = await this.client.profile.getLidsByPhoneNumbers(unknown.map((item) => item.phoneJid))
      const contacts: WaStoredContactRecord[] = []
      for (let i = 0; i < Math.min(lookups.length, unknown.length); i += 1) {
        const lookup = lookups[i]
        const { index, phoneJid } = unknown[i]
        const lid = toLidJid(lookup?.lidJid)
        if (!lookup?.exists || !lid) continue
        resolved[index] = lid
        contacts.push({
          jid: lid,
          lid,
          phoneNumber: phoneJid.split('@')[0],
          lastUpdatedMs: Date.now(),
        })
      }
      if (contacts.length) await this.store.contacts.upsertBatch(contacts)
    }

    return resolved
  }
}
