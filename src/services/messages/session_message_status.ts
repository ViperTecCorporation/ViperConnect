import type { Config } from '../config'
import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { zapoStoreRegistry } from '../zapo/zapo_store_registry'
import { resolveZapoRedisKeyPrefix } from '../zapo/zapo_store'
import { sessionMessageIndex, MESSAGE_CHANGE_CHANNEL, MERGE_MESSAGE_STATUS_LUA } from './session_message_index'
import { providerIdKey } from '../redis'
import logger from '../logger'

export const recordSessionWebhookStatuses = async (phone: string, payload: any, config: Config) => {
  if (config.provider !== 'zapo' || !config.useRedis) return
  const statuses = (payload?.entry || []).flatMap((entry: any) => (entry.changes || []).flatMap((change: any) => change.value?.statuses || []))
    .filter((item: any) => typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(item.id) && ['sent', 'failed', 'delivered', 'read', 'played'].includes(item.status)).slice(0, 100)
  if (!statuses.length) return
  try {
    zapoStoreRegistry.get(config)
    const index = sessionMessageIndex(resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX))
    if (!index) return
    const pipe = index.redis.pipeline()
    for (const status of statuses) {
      const state = { id: status.id, status: status.status, ...(status.status === 'failed' ? { error: 'O envio falhou no worker. Consulte o diagnóstico do webhook.' } : {}) }
      pipe.eval(`local old=redis.call('GET',KEYS[1]); local s=old and cjson.decode(old) or {}; local v=cjson.decode(ARGV[1]); ${MERGE_MESSAGE_STATUS_LUA}; redis.call('SET',KEYS[1],cjson.encode(s),'PX',ARGV[2]); return 1`, 1, index.key(phone, `outgoing:${status.id}`), JSON.stringify(state), index.ttl)
      pipe.get(providerIdKey(phone, status.id))
      pipe.publish(MESSAGE_CHANGE_CHANNEL, JSON.stringify({ phone, conversation_id: '', outgoing: state }))
    }
    const rows = await pipe.exec()
    for (let i = 0; i < statuses.length; i++) {
      const provider = rows?.[i * 3 + 1]?.[1]
      if (provider) await index.state(phone, [String(provider)], { status: statuses[i].status })
    }
  } catch { logger.warn('SESSION_MESSAGES_STATUS_FAILED session=%s', phone) }
}
