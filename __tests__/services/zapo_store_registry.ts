import { mockDeep } from 'jest-mock-extended'
import type { WaStore } from 'zapo-js'
import { defaultConfig } from '../../src/services/config'
import { ZapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'

describe('Zapo store registry', () => {
  test('reuses one backend per process and destroys it once', async () => {
    const store = mockDeep<WaStore>()
    const factory = jest.fn(() => store)
    const registry = new ZapoStoreRegistry(factory)
    const config = { ...defaultConfig, useRedis: false, baseStore: '/data' }

    expect(registry.get(config)).toBe(store)
    expect(registry.get(config)).toBe(store)
    expect(factory).toHaveBeenCalledTimes(1)

    await registry.destroy()
    expect(store.destroy).toHaveBeenCalledTimes(1)
  })
})
