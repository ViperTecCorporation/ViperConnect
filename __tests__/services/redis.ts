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
    if (_script.includes("'PXAT',deadline")) {
      store.set(options.keys[0], options.arguments[3])
      return 1
    }
    if (options.arguments[0] === 'save_config' || options.arguments[0] === 'remove') {
      if (mockClient.failNextExec) {
        mockClient.failNextExec = false
        throw new Error('transaction failed')
      }
      const [operation, phone] = options.arguments
      const key = options.keys[4]
      if (operation === 'save_config') {
        if (options.arguments[7] === 'cas' && (store.get(key) || '') !== options.arguments[8]) return 0
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
jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined), amqpRpc: jest.fn(), amqpConsume: jest.fn() }))

process.env.REDIS_URL = 'redis://mock'
import { webhookHistory } from '../../src/services/webhook_history'

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
  setMessage,
  getMessage,
  getMessageWithSecretAnySession,
  getRedis,
  getBulkReport,
} from '../../src/services/redis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { configs } from '../../src/services/config'
import { openSessionDatabase, closeAllSessionDatabases } from '../../src/services/session_storage/database'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { executeSessionStateCommands } from '../../src/services/session_storage/state_commands'
import { executeCompatibilityValue } from '../../src/services/session_storage/compat_redirect'
import * as storageRpc from '../../src/services/session_storage/rpc'
import * as configuration from '../../src/services/config_redis'
import { BulkSenderJob } from '../../src/jobs/bulk_sender'
import { BulkStatusJob } from '../../src/jobs/bulk_status'

describe('SQLite campaign statuses retain their report contract', () => {
  test.each(['worker', 'broker'])('actual campaign scheduling and classification are visible in the report through %s ownership', async role => {
    mockClient.__reset(); await getRedis()
    const phone = '999123456789', oldEnvironment = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'viper-bulk-flow-test-'))
    const previous = configs.get(phone)
    process.env.UNOAPI_PROCESS_ROLE = role; process.env.UNOAPI_SERVER_NAME = 'bulk_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID; process.env.SESSION_STORAGE_ROOT = directory
    const config: any = { provider: 'zapo', server: 'bulk_owner', useRedis: true, baseStore: directory,
      sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'bulk_owner', generation: 1, state: 'active', fixture: true } }
    configs.set(phone, config); store.set(`unoapi-config:${phone}`, JSON.stringify(config))
    const db = openSessionDatabase(phone, config, { create: true }), local = await getDataStoreSqlite(phone, config)
    const configSpy = jest.spyOn(configuration, 'getConfigRedis').mockResolvedValue(config)
    const rpcSpy = jest.spyOn(storageRpc, 'sessionStorageRpc').mockImplementation(async (_phone, selected, operation, args) => {
      const oldRole = process.env.UNOAPI_PROCESS_ROLE; process.env.UNOAPI_PROCESS_ROLE = 'worker'
      try {
        if (operation === 'state.commands') return executeSessionStateCommands(phone, selected, args![0] as any) as any
        if (operation === 'compat.get') return executeCompatibilityValue(phone, selected, 'get', args![0] as string) as any
        throw Error('unexpected_bulk_rpc')
      } finally { process.env.UNOAPI_PROCESS_ROLE = oldRole }
    })
    try {
      await local.setUnoId('provider-campaign', 'uno-campaign')
      await local.setKey('uno-campaign', { id: 'provider-campaign', remoteJid: '12345@lid', fromMe: true })
      const deadline = Date.now() + 15000
      db.putValue(`unoapi-message:${phone}:12345@lid:provider-campaign`, 'synthetic-copy', { expiresAt: deadline })
      const incoming: any = { send: jest.fn().mockResolvedValue({ ok: { messages: [{ id: 'uno-campaign' }] } }) }
      const outgoing: any = { formatAndSend: jest.fn().mockResolvedValue(undefined) }
      await new BulkSenderJob(incoming, outgoing).consume(phone, { payload: { id: 'campaign-fixture', messages: [{ payload: { to: '12345', type: 'text', text: { body: 'Synthetic only' } } }], length: 1 } })
      expect(incoming.send).toHaveBeenCalledTimes(1)
      expect(await getBulkReport(phone, 'campaign-fixture')).toMatchObject({ report: { '12345': 'scheduled' }, status: { scheduled: 1 } })
      expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-message-status:${phone}:uno-campaign`])?.expires_at).toBeLessThanOrEqual(deadline)
      await new BulkStatusJob().consume(phone, { payload: { entry: [{ changes: [{ value: { statuses: [{ id: 'uno-campaign', status: 'failed', errors: [{ code: 7 }] }] } }] }] } })
      expect(await getBulkReport(phone, 'campaign-fixture')).toMatchObject({ report: { '12345': 'invalid-phone-number' }, status: { 'invalid-phone-number': 1 } })
      expect(await local.loadStatus('provider-campaign')).toBe('invalid-phone-number')
      expect(store.has(`unoapi-message-status:${phone}:uno-campaign`)).toBe(false)
      if (role === 'broker') expect(rpcSpy).toHaveBeenCalled()
      else expect(rpcSpy).not.toHaveBeenCalled()
    } finally {
      rpcSpy.mockRestore(); configSpy.mockRestore(); configs.delete(phone); if (previous) configs.set(phone, previous)
      closeAllSessionDatabases(); rmSync(directory, { recursive: true, force: true }); process.env = oldEnvironment
    }
  })
})

describe('compatibility message age', () => {
  beforeEach(() => mockClient.__reset())
  test('encodes and writes with the original timestamp through the atomic retention guard', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 86400
    const value = { key: { id: 'a', remoteJid: '456@lid' }, messageTimestamp: timestamp, message: { conversation: 'hello' } }
    await setMessage('123', '456@lid', 'a', value)
    expect(mockClient.eval).toHaveBeenCalledWith(expect.stringContaining("'PXAT',deadline"), expect.objectContaining({ keys: ['unoapi-message:123:456@lid:a'], arguments: [expect.any(String), expect.any(String), String(timestamp * 1000), expect.any(String)] }))
    expect(await getMessage('123', '456@lid', 'a')).toMatchObject({ message: { conversation: 'hello' } })
  })
  test('read paths reject old JSON and protobuf entries that retain a historical sliding TTL', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 400 * 86400
    await setMessage('123', '456@lid', 'a', { messageTimestamp: timestamp, message: { conversation: 'old' } })
    expect(await getMessage('123', '456@lid', 'a')).toBeUndefined()
    const key = 'unoapi-message:123:456@lid:b'
    store.set(key, JSON.stringify({ messageTimestamp: timestamp, message: { messageContextInfo: { messageSecret: 'secret' } } }))
    expect(await getMessage('123', '456@lid', 'b')).toBeUndefined()
    mockClient.scan.mockResolvedValueOnce({ cursor: '0', keys: [key] })
    expect(await getMessageWithSecretAnySession('b')).toBeUndefined()
  })
  test('a Redis failure is propagated instead of replacing content with an encoding fallback', async () => {
    mockClient.eval.mockRejectedValueOnce(new Error('redis down'))
    await expect(setMessage('123', '456@lid', 'a', { messageTimestamp: Date.now() / 1000 })).rejects.toThrow('redis down')
    expect(mockClient.eval).toHaveBeenCalledTimes(1)
  })
  test('replaying an old sliding-TTL copy preserves its original age even if the incoming timestamp changes', async () => {
    const original = Math.floor(Date.now() / 1000) - 31 * 86400
    store.set('unoapi-message:123:456@lid:a', JSON.stringify({ messageTimestamp: original }))
    await setMessage('123', '456@lid', 'a', { messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'edit' } })
    expect(mockClient.eval.mock.calls[0][1].arguments[2]).toBe(String(original * 1000))
    expect(await getMessage('123', '456@lid', 'a')).toBeUndefined()
  })
})

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
  test('archives edits and removal but does not archive ordinary connection/config updates', async () => {
    mockClient.__reset()
    const capture = jest.spyOn(webhookHistory, 'capture').mockImplementation(() => {})
    try {
      const phone = '5511999999'
      await setConfig(phone, { provider: 'zapo', webhooks: [{ id: 'a', url: 'https://example.com' }] })
      await setConfig(phone, { name: 'New label' })
      expect(capture).not.toHaveBeenCalled()
      await setConfig(phone, { webhooks: [{ id: 'b', url: 'https://example.org' }], overrideWebhooks: true })
      expect(capture).toHaveBeenCalledWith(phone, expect.objectContaining({ webhooks: [expect.objectContaining({ id: 'a' })] }), 'updated')
      await delConfig(phone)
      expect(capture).toHaveBeenLastCalledWith(phone, expect.objectContaining({ webhooks: [expect.objectContaining({ id: 'b' })] }), 'removed')
      expect(await getConfig(phone)).toBeUndefined()
    } finally { capture.mockRestore() }
  })
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

describe('config compare-and-set storage fences', () => {
  beforeEach(() => { mockClient.__reset() })
  const phone = '9990100000781', key = `unoapi-config:${phone}`
  const descriptor = { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'server_1', generation: 1, state: 'offline' }
  const injectOnSave = (update: (config: any) => any) => {
    const realEval = mockClient.eval.getMockImplementation(); let changed = false
    mockClient.eval.mockImplementation(async (script, options) => {
      if (!changed && options.arguments[0] === 'save_config') { changed = true; store.set(key, JSON.stringify(update(JSON.parse(store.get(key)!)))) }
      return realEval(script, options)
    })
    return () => mockClient.eval.mockImplementation(realEval)
  }

  test('retries a public patch against fresh config without erasing a just-committed SQLite descriptor', async () => {
    await setConfig(phone, { provider: 'zapo', server: 'server_1', autoConnect: false })
    const restore = injectOnSave(config => ({ ...config, sessionStorage: descriptor }))
    try {
      await setConfig(phone, { label: 'concurrent public edit' })
      expect(await getConfig(phone)).toMatchObject({ label: 'concurrent public edit', sessionStorage: descriptor })
    } finally { restore() }
  })

  test('a lifecycle patch cannot rebase across a concurrent provision/storage commit', async () => {
    await setConfig(phone, { provider: 'zapo', server: 'server_1', autoConnect: false })
    const restore = injectOnSave(config => ({ ...config, sessionStorage: descriptor }))
    try {
      await expect(setConfig(phone, { autoConnect: true })).rejects.toThrow('session_storage_configuration_changed')
      expect(await getConfig(phone)).toMatchObject({ autoConnect: false, sessionStorage: descriptor })
    } finally { restore() }
  })

  test('stale full configurations cannot replace the backend or generation before the first CAS', async () => {
    store.set(key, JSON.stringify({ provider: 'zapo', server: 'server_1', sessionStorage: { ...descriptor, generation: 2 } }))
    await expect(setConfig(phone, { sessionStorage: descriptor })).rejects.toThrow('session_storage_configuration_changed')
    expect((await getConfig(phone)).sessionStorage.generation).toBe(2)
  })

  test('pending bootstrap cannot be enabled, cleared or replaced by a generic config setter', async () => {
    const pending = { id: '12345678-1234-4234-8234-123456789abc', autoConnect: true }
    store.set(key, JSON.stringify({ provider: 'zapo', server: 'server_1', autoConnect: false, sessionStorageProvisionPending: pending }))
    await expect(setConfig(phone, { autoConnect: true })).rejects.toThrow('session_storage_provision_unconfirmed')
    await expect(setConfig(phone, { sessionStorageProvisionPending: null })).rejects.toThrow('session_storage_configuration_changed')
    await expect(setConfig(phone, { sessionStorageProvisionPending: { ...pending, id: 'another' } })).rejects.toThrow('session_storage_configuration_changed')
    expect((await getConfig(phone)).sessionStorageProvisionPending).toEqual(pending)
  })

  test('initial-only creation cannot patch an already registered session', async () => {
    await setConfig(phone, { provider: 'zapo', label: 'keep' })
    await expect(setConfig(phone, { label: 'replace' }, { expectedAbsent: true })).rejects.toThrow('session_storage_configuration_changed')
    expect((await getConfig(phone)).label).toBe('keep')
  })

  test('required-existing callbacks cannot recreate a lost config or cross the selected storage generation', async () => {
    await expect(setConfig(phone, { authToken: 'synthetic' }, { expectedExisting: true })).rejects.toThrow('registration_required')
    expect(await getConfig(phone)).toBeUndefined()
    const previous = { provider: 'zapo', server: 'server_1', autoConnect: true, sessionStorage: descriptor }
    store.set(key, JSON.stringify({ ...previous, autoConnect: false, sessionStorage: { ...descriptor, generation: 2 } }))
    await expect(setConfig(phone, { authToken: 'synthetic' }, { expectedExisting: true, expectedConfig: previous })).rejects.toThrow('configuration_changed')
    expect(await getConfig(phone)).toMatchObject({ autoConnect: false, sessionStorage: { generation: 2 } })
    expect((await getConfig(phone)).authToken).toBeUndefined()
  })

  test('a retry never recreates a session removed concurrently with a public patch', async () => {
    await setConfig(phone, { provider: 'zapo', label: 'old' })
    const evaluate = mockClient.eval.getMockImplementation(); let removed = false
    mockClient.eval.mockImplementation(async (script, options) => {
      if (!removed && options.arguments[0] === 'save_config') { removed = true; store.delete(key) }
      return evaluate(script, options)
    })
    try {
      await expect(setConfig(phone, { label: 'stale edit' })).rejects.toThrow('session_storage_configuration_changed')
      expect(await getConfig(phone)).toBeUndefined(); expect(store.has(key)).toBe(false)
    } finally { mockClient.eval.mockImplementation(evaluate) }
  })

  test('CAS retry is bounded and a rejected webhook change is not archived as applied', async () => {
    await setConfig(phone, { provider: 'zapo', webhooks: [{ id: 'a', url: 'https://example.test/a' }] })
    const realEval = mockClient.eval.getMockImplementation(), capture = jest.spyOn(webhookHistory, 'capture').mockImplementation(() => {})
    mockClient.eval.mockImplementation(async (script, options) => options.arguments[0] === 'save_config' ? 0 : realEval(script, options))
    try {
      await expect(setConfig(phone, { webhooks: [{ id: 'b', url: 'https://example.test/b' }], overrideWebhooks: true })).rejects.toThrow('session_storage_configuration_changed')
      expect(capture).not.toHaveBeenCalled(); expect((await getConfig(phone)).webhooks[0].id).toBe('a')
    } finally { mockClient.eval.mockImplementation(realEval); capture.mockRestore() }
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
