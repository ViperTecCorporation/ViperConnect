import type { WaStore } from 'zapo-js'
import type { Config } from '../config'
import { createZapoStore } from './zapo_store'
import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { isSqliteSession, assertLocalStorageOwner } from '../session_storage/routing'
import { getSessionSqlitePath, openSessionDatabase } from '../session_storage/database'

type StoreFactory = typeof createZapoStore

export class ZapoStoreRegistry {
  private readonly stores = new Map<string, WaStore>()

  constructor(private readonly factory: StoreFactory = createZapoStore) {}

  get(config: Config, phone?: string) {
    const sqlite = isSqliteSession(config)
    if (sqlite) {
      assertLocalStorageOwner(config)
      if (!phone) throw new Error('session_storage_phone_required')
      openSessionDatabase(phone, config)
    }
    const key = sqlite ? `sqlite:${config.sessionStorage!.storageId}:${config.sessionStorage!.generation}` : config.useRedis
      ? `redis:${process.env.REDIS_URL || ''}:${ZAPO_REDIS_KEY_PREFIX}`
      : `sqlite:${config.baseStore}`
    const existing = this.stores.get(key)
    if (existing) return existing
    const store = this.factory({
      useRedis: sqlite ? false : config.useRedis,
      baseStore: config.baseStore,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: ZAPO_REDIS_KEY_PREFIX,
      ...(sqlite ? { sqlitePath: getSessionSqlitePath(phone!, config) } : {}),
      ...(sqlite ? { sqliteSession: { phone: phone!, config } } : {}),
    })
    this.stores.set(key, store)
    return store
  }

  async release(config: Config) {
    if (!isSqliteSession(config)) return
    const key = `sqlite:${config.sessionStorage!.storageId}:${config.sessionStorage!.generation}`
    const store = this.stores.get(key)
    if (store) { await store.destroy(); this.stores.delete(key) }
  }

  async destroy() {
    await Promise.all(Array.from(this.stores.values()).map((store) => store.destroy()))
    this.stores.clear()
  }
}

export const zapoStoreRegistry = new ZapoStoreRegistry()
