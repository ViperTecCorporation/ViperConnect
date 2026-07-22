import { mockDeep } from 'jest-mock-extended'
import type { WaStoreSession } from 'zapo-js'
import type { Config } from '../../src/services/config'
import { defaultConfig } from '../../src/services/config'
import { ensureZapoSessionMigration, migrateBaileysSessionToZapo } from '../../src/services/zapo/zapo_migration'

const config = (useRedis: boolean) => ({ ...defaultConfig, useRedis, baseStore: '/data' }) as Config

const dependencies = () => ({
  readFileSnapshot: jest.fn(),
  readRedisSnapshot: jest.fn(),
  convert: jest.fn(),
  write: jest.fn(),
})

describe('Zapo session migration', () => {
  test('skips migration when Zapo credentials already exist', async () => {
    const store = mockDeep<WaStoreSession>()
    store.auth.load.mockResolvedValue({ meJid: '5566@s.whatsapp.net' } as never)
    const deps = dependencies()

    await expect(migrateBaileysSessionToZapo('5566', config(true), store, deps)).resolves.toEqual({
      status: 'already-migrated',
      losses: [],
    })
    expect(deps.readRedisSnapshot).not.toHaveBeenCalled()
  })

  test('allows a new Zapo pairing when no Baileys source exists', async () => {
    const store = mockDeep<WaStoreSession>()
    store.auth.load.mockResolvedValue(null)
    const deps = dependencies()
    deps.readFileSnapshot.mockReturnValue(undefined)

    await expect(migrateBaileysSessionToZapo('5566', config(false), store, deps)).resolves.toEqual({
      status: 'source-not-found',
      losses: [],
    })
    expect(deps.readFileSnapshot).toHaveBeenCalledWith('5566', '/data')
  })

  test('converts, writes and validates a Baileys Redis session', async () => {
    const store = mockDeep<WaStoreSession>()
    store.auth.load.mockResolvedValueOnce(null).mockResolvedValueOnce({ meJid: '5566@s.whatsapp.net' } as never)
    const deps = dependencies()
    const source = { creds: {}, keys: {} } as never
    const destination = { credentials: {} } as never
    const losses = [{ domain: 'session', severity: 'warn', count: 1, reason: 'self-healing key' }] as never
    deps.readRedisSnapshot.mockResolvedValue(source)
    deps.convert.mockReturnValue({ data: destination, losses })

    await expect(migrateBaileysSessionToZapo('5566', config(true), store, deps)).resolves.toEqual({
      status: 'migrated',
      losses,
    })
    expect(deps.write).toHaveBeenCalledWith(store, destination)
  })

  test('deduplicates concurrent migration attempts for the same session', async () => {
    const store = mockDeep<WaStoreSession>()
    store.auth.load.mockResolvedValue(null)
    const deps = dependencies()
    let resolveRead: (value: undefined) => void = () => undefined
    deps.readRedisSnapshot.mockReturnValue(new Promise((resolve) => { resolveRead = resolve }))

    const first = ensureZapoSessionMigration('dedupe-5566', config(true), store, deps)
    const second = ensureZapoSessionMigration('dedupe-5566', config(true), store, deps)
    resolveRead(undefined)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'source-not-found', losses: [] },
      { status: 'source-not-found', losses: [] },
    ])
    expect(deps.readRedisSnapshot).toHaveBeenCalledTimes(1)
  })
})
