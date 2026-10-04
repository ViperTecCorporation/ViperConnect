import { contactInfoKey, contactNameKey, groupKey, jidMapPnKeyNew } from '../redis'
import type { SessionMessageIndex } from './session_message_index'
import { SendError } from '../send_error'

const object = (value: unknown): any => {
  try { return typeof value === 'string' ? JSON.parse(value) || {} : value || {} } catch { return {} }
}
const name = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim()) as string | undefined
const canonical = (jid: string) => jid.replace(/:\d+(?=@)/, '')

export const cachedMessageGroups = async (index: SessionMessageIndex, phone: string, ids: string[]) => {
  const groups = [...new Set(ids.filter(id => id.endsWith('@g.us')))].slice(0, 200)
  const pipe = index.redis.pipeline()
  groups.forEach(id => pipe.get(groupKey(phone, id)))
  const rows = groups.length ? await pipe.exec() : []
  if (rows?.some(([error]) => error)) throw new SendError(503, 'session_messages_read_failed')
  return new Map(groups.map((id, i) => [id, object(rows?.[i]?.[1])]))
}

export const cachedMessageSenderNames = async (index: SessionMessageIndex, phone: string, senders: string[], group: any) => {
  const ids = [...new Set(senders.filter(Boolean).map(canonical))].slice(0, 200)
  const read = async (keys: string[]) => {
    const pipe = index.redis.pipeline()
    keys.forEach(id => pipe.hgetall(`${index.native(phone, 'contact')}:${id}`).get(contactNameKey(phone, id)).get(contactInfoKey(phone, id)).get(jidMapPnKeyNew(phone, id)))
    const rows = keys.length ? await pipe.exec() : []
    if (rows?.some(([error]) => error)) throw new SendError(503, 'session_messages_read_failed')
    return new Map(keys.map((id, i) => {
      const contact = object(rows?.[i * 4]?.[1]); const info = object(rows?.[i * 4 + 2]?.[1])
      const participant = Array.isArray(group?.participants) ? group.participants.find((p: any) => canonical(p.jid || p.id || '') === id) : undefined
      return [id, { name: name(contact.display_name, rows?.[i * 4 + 1]?.[1], info.name, contact.push_name),
        alias: name(rows?.[i * 4 + 3]?.[1], info.pnJid, contact.phone_number, participant?.phoneNumber) }]
    }))
  }
  const contacts = await read(ids)
  const aliases = [...new Set([...contacts.values()].filter(c => !c.name && c.alias).map(c => canonical(c.alias!.includes('@') ? c.alias! : `${c.alias}@s.whatsapp.net`)))].filter(id => /^\d+@s\.whatsapp\.net$/.test(id) && !contacts.has(id))
  const alternatives = await read(aliases)
  return new Map(senders.map(sender => {
    const contact = contacts.get(canonical(sender))
    const alias = contact?.alias ? canonical(contact.alias.includes('@') ? contact.alias : `${contact.alias}@s.whatsapp.net`) : ''
    return [sender, (contact?.name || contacts.get(alias)?.name || alternatives.get(alias)?.name)?.trim().slice(0, 200)]
  }))
}
