const store = new Map<string, string>()
const sets = new Map<string, Set<string>>()

const addSetMembers = (key: string, members: string | string[]) => {
  const values = Array.isArray(members) ? members : [members]
  const target = sets.get(key) || new Set<string>()
  const before = target.size
  values.forEach((member) => target.add(member))
  sets.set(key, target)
  return target.size - before
}

const removeSetMembers = (key: string, members: string | string[]) => {
  const values = Array.isArray(members) ? members : [members]
  const target = sets.get(key) || new Set<string>()
  let removed = 0
  values.forEach((member) => { if (target.delete(member)) removed += 1 })
  return removed
}

const mockClient: any = {
  connect: jest.fn(async () => {}),
  on: jest.fn(),
  ping: jest.fn(async () => 'PONG'),
  get: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
  set: jest.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && store.has(key)) return null
    store.set(key, value)
    return 'OK'
  }),
  eval: jest.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
    if (options.arguments[0] === 'save_config' || options.arguments[0] === 'remove') {
      if (mockClient.failNextExec) {
        mockClient.failNextExec = false
        throw new Error('transaction failed')
      }
      const [operation, phone] = options.arguments
      const key = options.keys[4]
      if (operation === 'save_config') {
        store.set(key, options.arguments[5])
        addSetMembers(options.keys[5], phone)
      } else {
        store.delete(key)
        removeSetMembers(options.keys[5], phone)
      }
      return 1
    }
    const [key] = options.keys
    const [selfId, replacement] = options.arguments
    const current = store.get(key)
    if (current === selfId) {
      store.set(key, replacement)
      return replacement
    }
    return current || null
  }),
  del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  expire: jest.fn(async () => 1),
  publish: jest.fn(async () => 1),
  sAdd: jest.fn(async (key: string, members: string | string[]) => addSetMembers(key, members)),
  sRem: jest.fn(async (key: string, members: string | string[]) => removeSetMembers(key, members)),
  sMembers: jest.fn(async (key: string) => [...(sets.get(key) || [])]),
  mGet: jest.fn(async (keys: string[]) => keys.map((key) => store.get(key) || null)),
  scan: jest.fn(async () => ({ cursor: '0', keys: [] })),
  failNextExec: false,
  multi: jest.fn(() => {
    const operations: Array<() => unknown> = []
    const transaction: any = {
      set: (key: string, value: string) => {
        operations.push(() => store.set(key, value))
        return transaction
      },
      del: (key: string) => {
        operations.push(() => store.delete(key))
        return transaction
      },
      sAdd: (key: string, members: string | string[]) => {
        operations.push(() => addSetMembers(key, members))
        return transaction
      },
      sRem: (key: string, members: string | string[]) => {
        operations.push(() => removeSetMembers(key, members))
        return transaction
      },
      exec: async () => {
        if (mockClient.failNextExec) {
          mockClient.failNextExec = false
          throw new Error('transaction failed')
        }
        return operations.map((operation) => operation())
      },
    }
    return transaction
  }),
  __reset: () => {
    store.clear()
    sets.clear()
    mockClient.failNextExec = false
    mockClient.get.mockClear()
    mockClient.set.mockClear()
    mockClient.del.mockClear()
    mockClient.expire.mockClear()
    mockClient.eval.mockClear()
    mockClient.ping.mockClear()
    mockClient.publish.mockClear()
    mockClient.sAdd.mockClear()
    mockClient.sRem.mockClear()
    mockClient.sMembers.mockClear()
    mockClient.mGet.mockClear()
    mockClient.scan.mockClear()
    mockClient.multi.mockClear()
  },
}

jest.mock('@redis/client', () => ({
  createClient: jest.fn(() => mockClient),
}))

process.env.REDIS_URL = 'redis://mock'

import {
  acquireWebhookCircuitProbe,
  closeWebhookCircuit,
  getProviderId,
  getUnoId,
  isWebhookCircuitOpen,
  isWebhookCircuitRecovering,
  openWebhookCircuit,
  setUnoId,
  setJidMapping,
  getLidForPn,
  getPnForLid,
  removeJidMapping,
  setConfig,
  getConfig,
  delConfig,
  sessionPhoneIndexKey,
  setBlacklistAliases,
  blacklist,
} from '../../src/services/redis'

describe('redis blacklist identity transaction', () => {
  beforeEach(() => mockClient.__reset())
  test.each([-1, 60])('adds and removes all aliases atomically with ttl %s', async ttl => {
    const aliases = ['551234567890', '123@lid']
    await setBlacklistAliases('session', 'type', aliases, ttl)
    expect(mockClient.multi).toHaveBeenCalledTimes(1)
    for (const alias of aliases) expect(store.has(blacklist('session', 'type', alias))).toBe(true)
    await setBlacklistAliases('session', 'type', aliases, 0)
    for (const alias of aliases) expect(store.has(blacklist('session', 'type', alias))).toBe(false)
  })
  test('propagates transaction failure without applying half an update', async () => {
    mockClient.failNextExec = true
    await expect(setBlacklistAliases('session', 'type', ['123@lid', '551234567890'], -1)).rejects.toThrow('transaction failed')
    expect(store.size).toBe(0)
  })
})

describe('redis session phone index writes', () => {
  beforeEach(() => {
    mockClient.__reset()
  })

  it('atomically persists a new session config and indexes its phone', async () => {
    const phone = '5566996269251'

    await setConfig(phone, { authToken: 'token', webhooks: [] })

    expect(await getConfig(phone)).toEqual(expect.objectContaining({ authToken: 'token' }))
    expect(await mockClient.sMembers(sessionPhoneIndexKey())).toContain(phone)
    expect(mockClient.eval).toHaveBeenCalledWith(expect.stringContaining("operation == 'save_config'"), expect.objectContaining({
      keys: expect.arrayContaining([`unoapi-config:${phone}`, sessionPhoneIndexKey()]),
      arguments: expect.arrayContaining(['save_config', phone]),
    }))
  })

  it('keeps repeated pairing/config writes idempotent in the session index', async () => {
    const phone = '5566996269251'

    await setConfig(phone, { webhooks: [], provider: 'zapo' })
    await setConfig(phone, { webhooks: [], provider: 'zapo', name: 'updated' })

    expect(await mockClient.sMembers(sessionPhoneIndexKey())).toEqual([phone])
    expect(await getConfig(phone)).toEqual(expect.objectContaining({ name: 'updated' }))
  })

  it('atomically removes the config and its session index member', async () => {
    const phone = '5566996269251'
    await setConfig(phone, { webhooks: [] })
    mockClient.multi.mockClear()

    await delConfig(phone)

    expect(await getConfig(phone)).toBeUndefined()
    expect(await mockClient.sMembers(sessionPhoneIndexKey())).not.toContain(phone)
    expect(mockClient.eval).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      arguments: expect.arrayContaining(['remove', phone]),
    }))
  })

  it('does not leave a partial config or index entry when the transaction fails', async () => {
    const phone = '5566996269251'
    mockClient.failNextExec = true

    await expect(setConfig(phone, { webhooks: [] })).rejects.toThrow('transaction failed')

    expect(store.has(`unoapi-config:${phone}`)).toBe(false)
    expect(await mockClient.sMembers(sessionPhoneIndexKey())).not.toContain(phone)
  })

  it('keeps direct pairing config reads independent from index scans', async () => {
    const phone = '5566996269251'
    await setConfig(phone, { webhooks: [], provider: 'zapo' })
    mockClient.scan.mockClear()
    mockClient.sMembers.mockClear()

    await expect(getConfig(phone)).resolves.toEqual(expect.objectContaining({ provider: 'zapo' }))
    expect(mockClient.scan).not.toHaveBeenCalled()
    expect(mockClient.sMembers).not.toHaveBeenCalled()
  })
})

describe('redis.setUnoId', () => {
  beforeEach(() => {
    mockClient.__reset()
  })

  it('avoids duplicate uno ids for the same provider id', async () => {
    const phone = '5566996269251'
    const idBaileys = '3EB0E218CAA9D99ABAFE03'
    const unoA = 'd1e105c0-0151-11f1-8086-41fa32916297'
    const unoB = 'cfc5edf0-0151-11f1-8086-41fa32916297'

    const results = await Promise.all([
      setUnoId(phone, idBaileys, unoA),
      setUnoId(phone, idBaileys, unoB),
    ])

    const chosen = await getUnoId(phone, idBaileys)
    expect(chosen).toBeTruthy()
    expect([unoA, unoB]).toContain(chosen)
    expect(results).toEqual([chosen, chosen])

    const provider = await getProviderId(phone, chosen!)
    expect(provider).toBe(idBaileys)

    const other = chosen === unoA ? unoB : unoA
    const otherProvider = await getProviderId(phone, other)
    expect(otherProvider).toBeFalsy()
  })

  it('atomically repairs a legacy provider id mapped to itself', async () => {
    const phone = '5566996269251'
    const providerId = '3AB30E039E9D38AE82E4'
    const unoId = 'd1e105c0-0151-11f1-8086-41fa32916297'

    await setUnoId(phone, providerId, providerId)
    await expect(setUnoId(phone, providerId, unoId)).resolves.toBe(unoId)
    await expect(getUnoId(phone, providerId)).resolves.toBe(unoId)
    await expect(getProviderId(phone, unoId)).resolves.toBe(providerId)
  })
})

describe('redis.setJidMapping', () => {
  beforeEach(() => {
    mockClient.__reset()
  })

  it('keeps only one BR lid_for_pn mapping between 12 and 13 digit variants', async () => {
    const phone = '5566996269251'
    const lidJid = '123456789012345@lid'
    const pn12 = '556696923653@s.whatsapp.net'
    const pn13 = '5566996923653@s.whatsapp.net'

    await setJidMapping(phone, pn13, lidJid)
    await setJidMapping(phone, pn12, lidJid)

    expect(await getPnForLid(phone, lidJid)).toBe(pn12)
    expect(await getLidForPn(phone, pn12)).toBe(lidJid)
    expect(await getLidForPn(phone, pn13)).toBeUndefined()
  })

  it('normalizes device-qualified LID mappings before storing and reading', async () => {
    const phone = '5566996269251'
    const pn = '5517997666260@s.whatsapp.net'

    await setJidMapping(phone, pn, '190280070385782:35@lid')

    expect(await getPnForLid(phone, '190280070385782@lid')).toBe(pn)
    expect(await getPnForLid(phone, '190280070385782:35@lid')).toBe(pn)
    expect(await getLidForPn(phone, pn)).toBe('190280070385782@lid')
  })

  it('removes only the stale reverse alias after a PN is remapped to a new LID', async () => {
    const phone = '5566996269251'
    const pn = '5517997666260@s.whatsapp.net'
    const oldLid = '111@lid'
    const newLid = '222@lid'

    await setJidMapping(phone, pn, oldLid)
    await setJidMapping(phone, pn, newLid)
    await removeJidMapping(phone, pn, oldLid)

    expect(await getPnForLid(phone, oldLid)).toBeUndefined()
    expect(await getLidForPn(phone, pn)).toBe(newLid)
    expect(await getPnForLid(phone, newLid)).toBe(pn)
  })
})

describe('redis webhook circuit breaker', () => {
  beforeEach(() => {
    mockClient.__reset()
  })

  it('keeps recovery state and grants only one half-open probe', async () => {
    await openWebhookCircuit('5511', 'chatwoot', 120000, 30000)

    expect(await isWebhookCircuitOpen('5511', 'chatwoot')).toBe(true)
    expect(await isWebhookCircuitRecovering('5511', 'chatwoot')).toBe(true)
    expect(await acquireWebhookCircuitProbe('5511', 'chatwoot', 30000)).toBe(true)
    expect(await acquireWebhookCircuitProbe('5511', 'chatwoot', 30000)).toBe(false)
  })

  it('isolates an open circuit by session even when the webhook id is equal', async () => {
    await openWebhookCircuit('5511000000001', 'default', 120000, 30000)

    expect(await isWebhookCircuitOpen('5511000000001', 'default')).toBe(true)
    expect(await isWebhookCircuitOpen('5511000000002', 'default')).toBe(false)
  })

  it('clears open, failure, recovery and probe state after success', async () => {
    await openWebhookCircuit('5511', 'chatwoot', 120000, 30000)
    await acquireWebhookCircuitProbe('5511', 'chatwoot', 30000)
    await closeWebhookCircuit('5511', 'chatwoot')

    expect(await isWebhookCircuitOpen('5511', 'chatwoot')).toBe(false)
    expect(await isWebhookCircuitRecovering('5511', 'chatwoot')).toBe(false)
    expect(await acquireWebhookCircuitProbe('5511', 'chatwoot', 30000)).toBe(true)
  })
})
