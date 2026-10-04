import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { sessionMessageIndex } from './session_message_index'
import logger from '../logger'

export const recordSessionMessageEvent = async (phone: string, event: any, kind: 'receipt' | 'addon') => {
  const index = sessionMessageIndex(resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX))
  if (!index) return
  try {
    if (kind === 'receipt' && Array.isArray(event.messageIds) && ['delivered', 'read', 'played'].includes(event.status)) {
      await index.state(phone, event.messageIds, { status: event.status })
    } else if (kind === 'addon' && event.decrypted?.kind === 'message_edit' && event.targetMessageId) {
      const message = event.decrypted.message
      await index.state(phone, [event.targetMessageId], { edited: true, text: `${message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || ''}`.slice(0, 16000) })
    }
  } catch { logger.warn('SESSION_MESSAGES_EVENT_FAILED session=%s kind=%s', phone, kind) }
}
