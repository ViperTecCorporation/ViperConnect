import { getRedis } from './redis'
import type { replyWithoutQuoteWarning } from './api_messages'

export type ReplyWarningPending = {
  recipientId: string
  timestamp: string
  warnings: ReturnType<typeof replyWithoutQuoteWarning>[]
}

const outboxKey = (phone: string, id: string) => `unoapi-reply-warning:${phone}:${id}`

export const saveReplyWarning = async (phone: string, id: string, pending: ReplyWarningPending) => {
  if (!phone || !id || !pending.recipientId || !pending.warnings.length) throw new Error('reply_warning_identity_required')
  const redis = await getRedis()
  // Written before sending; a pending warning must survive until publication succeeds.
  await redis.set(outboxKey(phone, id), JSON.stringify(pending))
}

export const loadReplyWarning = async (phone: string, id: string): Promise<ReplyWarningPending | undefined> => {
  const redis = await getRedis()
  const raw = await redis.get(outboxKey(phone, id))
  if (!raw) return undefined
  const value = JSON.parse(raw)
  if (!value || typeof value.recipientId !== 'string' || typeof value.timestamp !== 'string'
    || !Array.isArray(value.warnings) || !value.warnings.length
    || value.warnings.some((warning: any) => warning?.code !== 'REPLY_SENT_WITHOUT_QUOTE' || typeof warning.message !== 'string')) {
    throw new Error('invalid_reply_warning')
  }
  return value
}

export const completeReplyWarning = async (phone: string, id: string) => {
  const redis = await getRedis()
  await redis.del(outboxKey(phone, id))
}

export const replyWarningStatus = (phone: string, id: string, pending: ReplyWarningPending, previous?: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: phone, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: phone, phone_number_id: phone },
    statuses: [{ id, recipient_id: pending.recipientId,
      status: ['delivered', 'read', 'deleted'].includes(previous || '') ? previous : 'sent',
      timestamp: pending.timestamp, warnings: pending.warnings }],
  } }] }],
})
