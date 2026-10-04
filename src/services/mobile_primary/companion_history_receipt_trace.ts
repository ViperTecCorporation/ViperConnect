import { createHash } from 'node:crypto'
import type { BinaryNode } from 'zapo-js'
import logger from '../logger'

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const receiptTypes = new Set(['hist_sync', 'delivery', 'read', 'read-self', 'peer_msg', 'sender', 'retry', 'inactive', 'server-error'])

/** Bounded, socket-local correlation. Never consumes a stanza or sends an ACK. */
export class CompanionHistoryReceiptTrace {
  private packets = new Map<string, { target: string; order: number; at: number }>()
  constructor(private readonly device: string) {}
  track(id: string, target: string, order: number): void {
    for (const [key, value] of this.packets) if (Date.now() - value.at > 900000) this.packets.delete(key)
    if (this.packets.size >= 2000) this.packets.delete(this.packets.keys().next().value!)
    this.packets.set(id, { target, order, at: Date.now() })
    logger.info({ device: this.device, packetHash: digest(id), targetHash: digest(target), packet: order }, 'MOBILE_COMPANION_HISTORY_PACKET_TRACKED')
  }
  observe(node: BinaryNode): false {
    try {
      if (node.tag !== 'receipt' && node.tag !== 'ack') return false
      const ids = new Set<string>()
      if (node.attrs.id) ids.add(node.attrs.id)
      if (Array.isArray(node.content)) for (const list of node.content) {
        if (list.tag === 'list' && Array.isArray(list.content)) for (const item of list.content) if (item.tag === 'item' && item.attrs.id) ids.add(item.attrs.id)
      }
      for (const id of ids) {
        const packet = this.packets.get(id)
        if (!packet) continue
        if (Date.now() - packet.at > 900000) { this.packets.delete(id); continue }
        logger.info({ device: this.device, packetHash: digest(id), packet: packet.order,
          kind: node.tag, receiptType: node.tag === 'ack' ? 'server_ack' : node.attrs.type == null ? 'delivery' : receiptTypes.has(node.attrs.type) ? node.attrs.type : 'other',
          senderHash: node.attrs.from ? digest(node.attrs.from) : undefined,
          participantHash: node.attrs.participant ? digest(node.attrs.participant) : undefined,
          exactTargetMatch: node.attrs.from === packet.target || node.attrs.participant === packet.target,
          errorCode: /^\d{3}$/.test(node.attrs.error || '') ? Number(node.attrs.error) : undefined,
          elapsedMs: Date.now() - packet.at,
        }, 'MOBILE_COMPANION_HISTORY_RECEIPT_OBSERVED')
      }
    } catch { /* Diagnostics must never interrupt the native receipt handler. */ }
    return false
  }
  clear(): void { this.packets.clear() }
}
