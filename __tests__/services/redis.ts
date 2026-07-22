const store = new Map<string, string>()

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
  del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  expire: jest.fn(async () => 1),
  __reset: () => {
    store.clear()
    mockClient.get.mockClear()
    mockClient.set.mockClear()
    mockClient.del.mockClear()
    mockClient.expire.mockClear()
    mockClient.ping.mockClear()
  },
}

jest.mock('@redis/client', () => ({
  createClient: jest.fn(() => mockClient),
}))

process.env.REDIS_URL = 'redis://mock'

import { getProviderId, getUnoId, setUnoId, setJidMapping, getLidForPn, getPnForLid } from '../../src/services/redis'

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
})
