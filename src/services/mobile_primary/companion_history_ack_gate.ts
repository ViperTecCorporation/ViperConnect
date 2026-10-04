import type { BinaryNode } from 'zapo-js'

/** One in-flight history packet per socket. Server ACK/peer_msg are not progress. */
export class CompanionHistoryAckGate {
  private pending?: { id: string; target: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

  async send(id: string, target: string, publish: () => Promise<unknown>, timeoutMs = 30000): Promise<void> {
    if (this.pending) throw new Error('mobile_history_packet_already_pending')
    let entry: NonNullable<CompanionHistoryAckGate['pending']>
    const receipt = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mobile_history_hist_sync_timeout')), timeoutMs)
      entry = { id, target, resolve, reject, timer }
      this.pending = entry
    })
    // A timeout/disposal can happen while publish still waits for the server.
    void receipt.catch(() => undefined)
    try { await publish(); await receipt } finally {
      clearTimeout(entry!.timer)
      if (this.pending === entry!) this.pending = undefined
    }
  }

  observe(node: BinaryNode): void {
    const entry = this.pending
    if (!entry || node.tag !== 'receipt' || node.attrs.type !== 'hist_sync') return
    if (node.attrs.from !== entry.target && node.attrs.participant !== entry.target) return
    const ids = [node.attrs.id]
    if (Array.isArray(node.content)) for (const list of node.content) {
      if (list.tag === 'list' && Array.isArray(list.content)) for (const item of list.content) {
        if (item.tag === 'item') ids.push(item.attrs.id)
      }
    }
    if (ids.includes(entry.id)) entry.resolve()
  }

  dispose(): void { this.pending?.reject(new Error('mobile_history_socket_disposed')) }
}
