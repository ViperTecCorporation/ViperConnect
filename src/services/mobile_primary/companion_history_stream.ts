import { proto, type WaStoreSession } from 'zapo-js'
import { collectCompanionHistory, historyPackets, resequenceHistoryPacket, type HistoryImageExperiment } from './companion_history_payload'

interface IndexRedis {
  scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number; keys: string[] }>
  zRange(key: string, start: number, stop: number): Promise<string[]>
}
/** Export bounded pages from the live archive, with no age or total-count cutoff.
 * This is not a transactional snapshot of active chats. */
export async function* streamCompanionHistory(store: WaStoreSession, redis: IndexRedis, prefix: string, phone: string, textOnly: boolean | 'text-video' = false, enrich?: (conversations: proto.IConversation[]) => Promise<void>, imageExperiment?: HistoryImageExperiment): AsyncGenerator<{ message: proto.Message.IProtocolMessage; count: number }> {
  if (!/^[A-Za-z0-9_:]+$/.test(prefix) || !/^[1-9]\d{7,14}$/.test(phone)) throw new Error('history_index_scope_invalid')
  const start = `${prefix}msg:idx:${phone}:`, seen = new Set<string>(), now = Date.now()
  let cursor = 0
  let pending: Awaited<ReturnType<typeof historyPackets>>[number] | undefined, order = 0
  let pendingJid: string | undefined
  const indexKeys = new Set<string>()
  do {
    const page = await redis.scan(cursor, { MATCH: start + '*', COUNT: 200 })
    cursor = page.cursor
    for (const key of page.keys) if (key.startsWith(start)) indexKeys.add(key)
  } while (cursor !== 0)
  // SCAN order is not stable; keep packet order reproducible between links.
  for (const key of [...indexKeys].sort()) {
      if (!key.startsWith(start) || seen.has(key)) continue
      seen.add(key)
      const jid = key.slice(start.length)
      if (!/^\d+(@(lid|s\.whatsapp\.net)|-?\d*@g\.us)$/.test(jid)) continue
      const thread = await store.threads.getByJid(jid) || { jid }
      if (thread.ephemeralExpiration) continue
      const contact = await store.contacts?.getByJid(jid)
      const pn = contact?.phoneNumber?.replace(/@s\.whatsapp\.net$/, '')
      const mappings = jid.endsWith('@lid') && pn && /^\d+$/.test(pn) ? [{ pnJid: `${pn}@s.whatsapp.net`, lidJid: jid }] : []
      const changed = new Set<string>()
      // Read tombstones first so a later page cannot resurrect an older original.
      for (let offset = 0; ; offset += 20) {
        const ids = await redis.zRange(key, offset, offset + 19)
        for (const id of ids) {
          const record = await store.messages.getById(id)
          try {
            if (!record?.messageBytes || record.messageBytes.length > 65536) continue
            const p = proto.Message.decode(record.messageBytes).protocolMessage
            if (p?.key?.id && [proto.Message.ProtocolMessage.Type.REVOKE, proto.Message.ProtocolMessage.Type.MESSAGE_EDIT].includes(p.type!)) changed.add(p.key.id)
          } catch { /* Invalid records cannot become history. */ }
        }
        if (ids.length < 20) break
      }
      for (let offset = 0; ; offset += 20) {
        const ids = await redis.zRange(key, offset, offset + 19)
        if (!ids.length) break
        const records = (await Promise.all(ids.filter(id => !changed.has(id)).map(id => store.messages.getById(id)))).filter((record): record is NonNullable<typeof record> => !!record)
        // Reuse privacy/type validation on each bounded page, with no age cutoff.
        const pageStore = { messages: { listByThread: async () => records } } as unknown as WaStoreSession
        const selected = await collectCompanionHistory(pageStore, now, [{ ...thread, name: thread.name || contact?.displayName || contact?.pushName }], true, imageExperiment)
        // Controlled lab experiment: filter only the export, never the archive.
        // Keep conversation metadata and timestamps unchanged to isolate media.
        if (textOnly) for (const conversation of selected.conversations) {
          conversation.messages = conversation.messages?.filter(item => typeof item.message?.message?.conversation === 'string'
            || (textOnly === 'text-video' && !!item.message?.message?.videoMessage))
        }
        if (enrich) await enrich(selected.conversations)
        for (const packet of await historyPackets(selected.conversations, mappings)) {
          if (pending) yield await resequenceHistoryPacket(pending, order++, false, pendingJid !== jid)
          pending = packet
          pendingJid = jid
        }
        if (ids.length < 20) break
      }
  }
  if (pending) yield await resequenceHistoryPacket(pending, order, true)
}
