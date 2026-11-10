import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { mockDeep } from 'jest-mock-extended'
import type { WaClient } from 'zapo-js'
import { configs } from '../../src/services/config'
import { getRedis } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { sessionStorageRpc } from '../../src/services/session_storage/rpc'
import { openSessionDatabase, closeAllSessionDatabases } from '../../src/services/session_storage/database'
import { executeSessionStateCommands } from '../../src/services/session_storage/state_commands'
import { getDataStoreSqlite } from '../../src/services/session_storage/data_store_sqlite'
import { saveTranscriptionReference, loadTranscriptionReference } from '../../src/services/transcription_reference'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'
import { ZapoProfilePictures } from '../../src/services/zapo/zapo_profile_pictures'

jest.mock('../../src/services/redis', () => ({ BASE_KEY: 'unoapi-', getRedis: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/session_storage/rpc', () => {
  const real = jest.requireActual('../../src/services/session_storage/rpc')
  return { ...real, sessionStorageRpc: jest.fn() }
})
jest.mock('../../src/services/reply_warning_outbox', () => ({ saveReplyWarning: jest.fn(), completeReplyWarning: jest.fn() }))
const phone = '999123456789', jid = '12345@lid', group = '12345@g.us'
let root: string, config: any, oldEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  oldEnvironment = { ...process.env }; process.env.UNOAPI_PROCESS_ROLE = 'worker'; process.env.UNOAPI_SERVER_NAME = 'flow_owner'; delete process.env.UNOAPI_STORAGE_WORKER_ID
  root = mkdtempSync(join(tmpdir(), 'viper-message-flow-test-')); process.env.SESSION_STORAGE_ROOT = root
  config = { provider: 'zapo', useRedis: true, baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'flow_owner', generation: 1, state: 'active', fixture: true } }
  configs.set(phone, config); openSessionDatabase(phone, config, { create: true }); jest.clearAllMocks()
  ;(getConfigRedis as jest.Mock).mockResolvedValue(config)
  ;(sessionStorageRpc as jest.Mock).mockImplementation(async (_phone, selected, operation, args) => {
    const role = process.env.UNOAPI_PROCESS_ROLE; process.env.UNOAPI_PROCESS_ROLE = 'worker'
    try {
      if (operation === 'state.commands') return executeSessionStateCommands(phone, selected, args[0])
      if (operation.startsWith('data.')) return (await getDataStoreSqlite(phone, selected) as any)[operation.slice(5)](...args)
      throw Error('unexpected_rpc_operation')
    } finally { process.env.UNOAPI_PROCESS_ROLE = role }
  })
})
afterEach(() => { configs.delete(phone); closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }); process.env = oldEnvironment; jest.restoreAllMocks() })

test.each(['worker', 'web'])('transcription reference persists through %s and quotes the exact original audio/group participant in the Zapo call', async role => {
  const local = await getDataStoreSqlite(phone, config), key = { id: 'provider-audio', remoteJid: group, participant: jid, fromMe: false }
  await local.setUnoId('provider-audio', 'uno-audio'); await local.setKey('uno-audio', key); await local.setKey('provider-audio', key)
  process.env.UNOAPI_PROCESS_ROLE = role
  const id = await saveTranscriptionReference(phone, group, 'uno-audio')
  expect(await loadTranscriptionReference(phone, id)).toBe('uno-audio')
  const db = openSessionDatabase(phone, config)
  expect(db.get('SELECT expires_at FROM uno_kv WHERE key=?', [`unoapi-transcription-reference:${phone}:${id}`])?.expires_at).toBeNull()
  const client = mockDeep<WaClient>(); client.message.send.mockResolvedValue({ id: 'reply-provider' } as never)
  const data = role === 'worker' ? local : {
    ...local,
    loadKey: async (value: string) => sessionStorageRpc(phone, config, 'data.loadKey', [value]),
    loadProviderId: async (value: string) => sessionStorageRpc(phone, config, 'data.loadProviderId', [value]),
    loadUnoId: async (value: string) => sessionStorageRpc(phone, config, 'data.loadUnoId', [value]),
    setUnoId: async (...args: unknown[]) => sessionStorageRpc(phone, config, 'data.setUnoId', args),
    setKey: async (...args: unknown[]) => sessionStorageRpc(phone, config, 'data.setKey', args),
  } as any
  const result = await new ZapoMessages(client, data, { phone }).send({ to: group, type: 'text', text: { body: 'Synthetic reply' }, context: { message_id: id } }, { unoMessageId: 'reply-uno' })
  expect(client.message.send).toHaveBeenCalledTimes(1)
  expect(client.message.send).toHaveBeenCalledWith(group, { type: 'text', text: 'Synthetic reply' }, expect.objectContaining({ quote: expect.objectContaining(key) }))
  expect(result.ok.warnings).toBeUndefined()
  expect(getRedis).not.toHaveBeenCalled()
  if (role === 'web') expect(sessionStorageRpc).toHaveBeenCalledWith(phone, config, 'state.commands', expect.any(Array))
})

test('migrated old-schema references stay readable without rewriting and malformed references fail explicitly', async () => {
  const db = openSessionDatabase(phone, config), id = await saveTranscriptionReference(phone, jid, 'audio')
  const oldId = `uno-transcription:${createHash('sha256').update(JSON.stringify([phone, jid, 'old-audio'])).digest('hex')}`
  const oldKey = `unoapi-transcription-reference:${phone}:${oldId}`, original = JSON.stringify({ conversation: jid, audioId: 'old-audio' })
  db.putValue(oldKey, original); expect(await loadTranscriptionReference(phone, oldId)).toBe('old-audio'); expect(db.getValue(oldKey)?.toString()).toBe(original)
  db.putValue(`unoapi-transcription-reference:${phone}:${id}`, JSON.stringify({ conversation: jid, audioId: 'different' }))
  await expect(loadTranscriptionReference(phone, id)).rejects.toThrow('invalid_transcription_reference')
  configs.set(phone, { ...config, sessionStorage: { ...config.sessionStorage, state: 'restoring' } })
  await expect(saveTranscriptionReference(phone, jid, 'late-audio')).rejects.toThrow('operation_in_progress')
  expect(getRedis).not.toHaveBeenCalled()
})

test.each(['sqlite', 'sqlite-remote'])('actual profile-picture service keeps miss and webhook cooldown across instances for %s', async type => {
  if (type === 'sqlite-remote') process.env.UNOAPI_PROCESS_ROLE = 'web'
  const options: any = { phone, client: {}, session: {}, store: { dataStore: { type }, mediaStore: {} }, enabled: true, notFoundTtlSeconds: 60, webhookIntervalSeconds: 60 }
  const first: any = new ZapoProfilePictures(options), next: any = new ZapoProfilePictures(options), now = Date.now()
  await first.missCache.mark(phone, jid, now); await first.webhookMarker.markSent(phone, jid, now)
  expect(await next.missCache.has(phone, jid, now + 1)).toBe(true)
  expect(await next.webhookMarker.isDue(phone, jid, now + 1)).toBe(false)
  await next.missCache.invalidate(phone, jid); await next.webhookMarker.invalidate(phone, jid)
  expect(await first.missCache.has(phone, jid, now + 1)).toBe(false)
  expect(await first.webhookMarker.isDue(phone, jid, now + 1)).toBe(true)
  expect(getRedis).not.toHaveBeenCalled()
})
