import type { WaStore } from 'zapo-js'
import type { Config } from '../config'
import { createZapoStore } from './zapo_store'
import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'

type StoreFactory = typeof createZapoStore

export class ZapoStoreRegistry {
  private readonly stores = new Map<string, WaStore>()

  constructor(private readonly factory: StoreFactory = createZapoStore) {}

  get(config: Config) {
    const key = config.useRedis
      ? `redis:${process.env.REDIS_URL || ''}:${ZAPO_REDIS_KEY_PREFIX}`
      : `sqlite:${config.baseStore}`
    const existing = this.stores.get(key)
    if (existing) return existing
    const store = this.factory({
      useRedis: config.useRedis,
      baseStore: config.baseStore,
      redisUrl: process.env.REDIS_URL,
      redisKeyPrefix: ZAPO_REDIS_KEY_PREFIX,
    })
    this.stores.set(key, store)
    return store
  }

  async destroy() {
    await Promise.all(Array.from(this.stores.values()).map((store) => store.destroy()))
    this.stores.clear()
  }
}

export const zapoStoreRegistry = new ZapoStoreRegistry()
