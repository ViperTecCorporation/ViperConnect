import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { sessionMessageIndex } from './session_message_index'
import logger from '../logger'
import type { Config } from '../config'
import { isSqliteSession, isStorageWorker, storageOwner } from '../session_storage/routing'
import { sessionStorageRpc } from '../session_storage/rpc'
import { applySqliteMessageEvent } from '../session_storage/status_projection'
import { rethrowSessionStateFence } from '../session_storage/private_state'

export const recordSessionMessageEvent = async (phone: string, event: any, kind: 'receipt' | 'addon', config?: Config) => {
  if (config && isSqliteSession(config)) {
    try {
      let ids: string[] = [], value: { status?: string; edited?: boolean; text?: string } = {}
      if (kind === 'receipt' && Array.isArray(event.messageIds) && ['delivered', 'read', 'played'].includes(event.status)) {
        ids = event.messageIds.filter((id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)).slice(0, 100); value = { status: event.status }
      } else if (kind === 'addon' && event.decrypted?.kind === 'message_edit' && typeof event.targetMessageId === 'string') {
        const message = event.decrypted.message
        ids = [event.targetMessageId]; value = { edited: true, text: `${message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || message?.documentMessage?.caption || ''}`.slice(0, 16000) }
      }
      if (!ids.length) return
      if (isStorageWorker() && config.sessionStorage!.owner === storageOwner()) await applySqliteMessageEvent(phone, config, ids, value)
      else await sessionStorageRpc(phone, config, 'query.events', [ids, value])
    } catch (error) { rethrowSessionStateFence(error); logger.warn('SESSION_MESSAGES_EVENT_FAILED session=%s kind=%s', phone, kind) }
    return
  }
  const index = sessionMessageIndex(resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX))
  if (!index) return
  try {
    if (kind === 'receipt' && Array.isArray(event.messageIds) && ['delivered', 'read', 'played'].includes(event.status)) {
      await index.state(phone, event.messageIds, { status: event.status })
    } else if (kind === 'addon' && event.decrypted?.kind === 'message_edit' && event.targetMessageId) {
      const message = event.decrypted.message
      await index.state(phone, [event.targetMessageId], { edited: true, text: `${message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || ''}`.slice(0, 16000) })
    }
  } catch (error) { rethrowSessionStateFence(error); logger.warn('SESSION_MESSAGES_EVENT_FAILED session=%s kind=%s', phone, kind) }
}
