import type { WaIncomingMessageEvent, WaStoreSession } from 'zapo-js'

/** Learn the sender's profile name without overwriting an imported address-book name. */
export async function persistMobileContactName(
  contacts: WaStoreSession['contacts'] | undefined,
  event: WaIncomingMessageEvent,
): Promise<void> {
  const name = typeof event.pushName === 'string' ? event.pushName.trim().slice(0, 256) : ''
  if (!contacts || !name || event.key.fromMe || event.key.isNewsletter) return
  const group = event.key.isGroup || event.key.remoteJid?.endsWith('@g.us')
  if (!group && !/^\d+(?::\d+)?@(lid|s\.whatsapp\.net)$/.test(event.key.remoteJid || '')) return
  const aliases = (group
    ? [event.key.participant, event.key.participantAlt]
    : [event.key.remoteJid, event.key.remoteJidAlt])
    .filter((jid): jid is string => typeof jid === 'string' && /^\d+(?::\d+)?@(lid|s\.whatsapp\.net)$/.test(jid))
    .map(jid => jid.replace(/:\d+@/, '@'))
  if (!aliases.length) return
  const lid = aliases.find(jid => jid.endsWith('@lid'))
  const stored = await contacts.getByJid(lid || aliases[0])
  const jid = lid || stored?.jid || aliases[0]
  if (stored?.pushName === name) return
  // Both official stores merge defined fields. Do not copy a stale displayName
  // from the read above: an import may update it concurrently.
  await contacts.upsert({ jid, pushName: name, lastUpdatedMs: Date.now() })
}
