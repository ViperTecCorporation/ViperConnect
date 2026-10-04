import { proto, type WaStoreSession } from 'zapo-js'
import type { DataStore } from '../data_store'

/** message_send is emitted before transport completion. Capture only; commit
 * after send resolves, using the provider ID, never a typed input DTO. */
export class ZapoSentArchive {
  private pending = new Map<string, { to: string; bytes: Uint8Array; at: number }>()

  capture(event: { id: string; to: string; message: proto.IMessage }) {
    if (!event.id || !event.message) return
    const now = Date.now()
    for (const [id, entry] of this.pending) if (now - entry.at > 300000) this.pending.delete(id)
    if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!)
    this.pending.set(event.id, { to: event.to, bytes: proto.Message.encode(event.message).finish(), at: now })
  }

  async commit(id: string, cache: DataStore, store?: WaStoreSession) {
    const entry = this.pending.get(id)
    this.pending.delete(id)
    if (!entry) return false
    const previous = await store?.messages.getById(id)
    const timestampMs = previous?.timestampMs || entry.at
    const message = proto.Message.decode(entry.bytes)
    await store?.messages.upsert({ ...previous, id, threadJid: entry.to, fromMe: true,
      timestampMs, messageBytes: entry.bytes })
    await cache.setMessage(entry.to, { key: { id, remoteJid: entry.to, fromMe: true },
      messageTimestamp: Math.floor(timestampMs / 1000), message } as never)
    return true
  }
}
