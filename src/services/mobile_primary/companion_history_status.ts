import { proto } from 'zapo-js'
import { resolveUnoMessageId } from '../message_id_map'

/** Read-only bridge: history keys remain provider IDs. Never infer delivery. */
export async function applyHistoryStatus(
  conversations: proto.IConversation[],
  loadUnoId: (id: string) => Promise<string | undefined>,
  loadStatus: (id: string) => Promise<string | undefined>,
) {
  const statuses: Record<string, proto.WebMessageInfo.Status> = {
    sent: proto.WebMessageInfo.Status.SERVER_ACK,
    delivered: proto.WebMessageInfo.Status.DELIVERY_ACK,
    read: proto.WebMessageInfo.Status.READ,
    played: proto.WebMessageInfo.Status.PLAYED,
    failed: proto.WebMessageInfo.Status.ERROR,
  }
  for (const conversation of conversations) for (const item of conversation.messages || []) {
    const message = item.message
    if (!message?.key?.fromMe || !message.key.id) continue
    const unoId = await resolveUnoMessageId({ loadUnoId, loadProviderId: async () => undefined }, message.key.id)
    const status = await loadStatus(unoId || message.key.id)
    if (status && Object.prototype.hasOwnProperty.call(statuses, status)) message.status = statuses[status]
  }
}
