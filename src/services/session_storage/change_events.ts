import { MESSAGE_CHANGE_CHANNEL } from '../messages/session_message_index'

export type SqliteMessageChangeCallback = (phone: string, conversationId: string, id?: string) => Promise<void> | void

/** The shared bus carries invalidations only; SQLite contents and secrets stay local. */
export const publishSqliteMessageChange: SqliteMessageChangeCallback = async (phone, conversationId, id) => {
  if (!/^[1-9]\d{7,14}$/.test(phone) || typeof conversationId !== 'string' || conversationId.length > 200 || id !== undefined && (typeof id !== 'string' || id.length > 200)) throw new Error('session_storage_invalid_change_event')
  const { getRedis } = module.require('../redis.js') as typeof import('../redis')
  const redis = await getRedis()
  await redis.publish(MESSAGE_CHANGE_CHANNEL, JSON.stringify({ phone, conversation_id: conversationId, ...(id ? { id } : {}) }))
}
