import type Redis from 'ioredis'
import type { WaStore } from 'zapo-js'
import logger from '../logger'

const preparations = new WeakMap<WaStore, () => Promise<void>>()
const STATE_KEY = /^(?:signal:(?:reg|spk|meta|sess|ident|pk)|sk|skd|appstate:(?:key|col|idx)|privtoken):/

/** SCAN/PERSIST only: no values read, no keys recreated, no cache TTLs changed. */
export async function persistZapoState(redis: Pick<Redis, 'scan' | 'pipeline'>, prefix: string) {
  if (!prefix || !/^[A-Za-z0-9_:]+$/.test(prefix)) throw new Error('Invalid Zapo persistence prefix')
  let cursor = '0'
  let persisted = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 250)
    const selected = keys.filter((key) => key.startsWith(prefix) && STATE_KEY.test(key.slice(prefix.length)))
    for (let offset = 0; offset < selected.length; offset += 100) {
      const pipeline = redis.pipeline()
      for (const key of selected.slice(offset, offset + 100)) pipeline.persist(key)
      const results = await pipeline.exec()
      if (!results) throw new Error('Zapo persistence pipeline returned no results')
      for (const [error, result] of results) {
        if (error) throw error
        persisted += Number(result) || 0
      }
    }
    cursor = next
  } while (cursor !== '0')
  logger.info('ZAPO_STATE_PERSIST_COMPLETE persisted=%s', persisted)
  return persisted
}

export function registerZapoStatePreparation(store: WaStore, redis: Pick<Redis, 'scan' | 'pipeline'>, prefix: string) {
  let pending: Promise<void> | undefined
  preparations.set(store, () => {
    if (!pending) pending = persistZapoState(redis, prefix).then(() => undefined).catch((error) => {
      pending = undefined
      logger.error('ZAPO_STATE_PERSIST_FAILED; session startup will retry')
      throw error
    })
    return pending
  })
}

/** Await before opening a socket; repeated callers share preparation per backend. */
export async function prepareZapoState(store: WaStore) {
  await preparations.get(store)?.()
}
