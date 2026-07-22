/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../src/services/zapo/zapo_migration', () => ({
  ensureZapoSessionMigration: jest.fn().mockResolvedValue({ status: 'migrated', losses: [] }),
}))
jest.mock('../../src/services/passkey_bridge', () => ({
  createPasskeyBridgeSession: jest.fn().mockResolvedValue({ status: 'request' }),
  updatePasskeyBridgeSession: jest.fn().mockResolvedValue({ status: 'response-sent' }),
}))
jest.mock('../../src/services/status/status_recipients', () => ({
  statusRecipients: {
    loadOrBootstrap: jest.fn().mockResolvedValue([]),
    touch: jest.fn().mockResolvedValue(undefined),
  },
}))

import { mockDeep } from 'jest-mock-extended'
import type { WaClient, WaStore, WaStoreSession } from 'zapo-js'
import { ClientZapo } from '../../src/services/client_zapo'
import { clients } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import type { Listener } from '../../src/services/listener'
import type { SessionStore } from '../../src/services/session_store'
import type { Store } from '../../src/services/store'
import { ensureZapoSessionMigration } from '../../src/services/zapo/zapo_migration'

describe('ClientZapo', () => {
  const phone = '5566999999999'
  let client: ReturnType<typeof mockDeep<WaClient>>
  let session: ReturnType<typeof mockDeep<WaStoreSession>>
  let sessionStore: ReturnType<typeof mockDeep<SessionStore>>
  let dataStore: ReturnType<typeof mockDeep<DataStore>>
  let listener: ReturnType<typeof mockDeep<Listener>>
  let handlers: Record<string, (...args: any[]) => any>
  let service: ClientZapo
  let config: typeof defaultConfig

  beforeEach(() => {
    clients.clear()
    jest.clearAllMocks()
    handlers = {}
    client = mockDeep<WaClient>()
    session = mockDeep<WaStoreSession>()
    sessionStore = mockDeep<SessionStore>()
    dataStore = mockDeep<DataStore>()
    listener = mockDeep<Listener>()
    sessionStore.isStatusOnline.mockResolvedValue(false)
    client.on.mockImplementation(((event: string, handler: (...args: any[]) => any) => {
      handlers[event] = handler
      return client
    }) as never)
    client.connect.mockResolvedValue(undefined)
    client.message.send.mockResolvedValue({ id: 'zapo-message-1' } as never)
    client.profile.getLidsByPhoneNumbers.mockResolvedValue([
      { exists: true, phoneJid: '5566111@s.whatsapp.net', lidJid: '111@lid' },
      { exists: false, invalid: true },
    ] as never)
    client.message.requestHistorySync.mockResolvedValue({ messageId: 'history-1' } as never)
    client.auth.requestPairingCode.mockResolvedValue('1234-5678')
    client.group.queryAllGroups.mockResolvedValue([])
    client.group.queryGroupMetadata.mockResolvedValue({ id: '120363@g.us', subject: 'Equipe' } as never)
    const unoStore = { sessionStore, dataStore } as unknown as Store
    config = { ...defaultConfig, provider: 'zapo' as const, getStore: jest.fn().mockResolvedValue(unoStore) }
    const zapoStore = { session: jest.fn().mockReturnValue(session) } as unknown as WaStore
    service = new ClientZapo(
      phone,
      listener,
      jest.fn().mockResolvedValue(config),
      jest.fn(),
      { get: jest.fn().mockReturnValue(zapoStore), destroy: jest.fn() },
      jest.fn().mockReturnValue(client),
    )
  })

  test('connects after migration and binds Zapo events', async () => {
    await service.connect(1)
    expect(ensureZapoSessionMigration).toHaveBeenCalledWith(phone, expect.objectContaining({ provider: 'zapo' }), session)
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(['auth_qr', 'connection', 'message', 'receipt', 'voip_call_incoming']))
  })

  test('maps connection, message and receipt events to Uno listener contracts', async () => {
    await service.connect(1)
    await handlers.connection({ status: 'open', isNewLogin: false })
    await handlers.message({
      key: { id: 'in-1', remoteJid: '111@lid', remoteJidAlt: '5511@s.whatsapp.net', fromMe: false, isNewsletter: false },
      timestampSeconds: 1,
      message: { conversation: 'oi' },
    })
    await handlers.receipt({ messageIds: ['in-1'], chatJid: '111@lid', status: 'read', timestampMs: 2000 })
    await handlers.group({ groupJid: '120363@g.us', chatJid: '120363@g.us', action: 'subject' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(sessionStore.setStatus).toHaveBeenCalledWith(phone, 'online')
    expect(listener.process).toHaveBeenCalledWith(phone, expect.any(Array), 'notify')
    expect(listener.process).toHaveBeenCalledWith(phone, expect.any(Array), 'update')
    expect(dataStore.setGroupMetada).toHaveBeenCalledWith('120363@g.us', expect.objectContaining({ subject: 'Equipe' }))
  })

  test('delegates messages, contacts, history, privacy and app state operations', async () => {
    session.privacyToken.getByJid.mockResolvedValue({ token: Buffer.from('x') } as never)
    await service.connect(1)
    await expect(service.send({ to: '5566111', type: 'text', text: { body: 'oi' } }, {})).resolves.toEqual(expect.objectContaining({ ok: expect.any(Object) }))
    await expect(service.contacts(['5566111', 'invalid'])).resolves.toEqual([
      expect.objectContaining({ status: 'valid', wa_id: '5566111', user_id: '111@lid' }),
      expect.objectContaining({ status: 'invalid' }),
    ])
    await expect(service.fetchMessageHistory({ count: 5 })).resolves.toEqual({ request_id: 'history-1' })
    await expect(service.fetchPrivacyTokens(['5566111@s.whatsapp.net'])).resolves.toEqual(expect.objectContaining({ stored: 1 }))
    await expect(service.requestPairingCode()).resolves.toBe('1234-5678')
    expect(client.auth.requestPairingCode).toHaveBeenCalledWith(phone)
    await service.resyncAppState()
    expect(client.chat.sync).toHaveBeenCalledTimes(1)
  })

  test('disconnects and logs out without deleting migrated source credentials', async () => {
    await service.connect(1)
    await service.logout()
    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(sessionStore.setStatus).toHaveBeenLastCalledWith(phone, 'offline')
  })

  test('owns Redis-backed sessions with a distributed lease and runs index maintenance', async () => {
    config.useRedis = true
    const lease = {
      acquire: jest.fn().mockResolvedValue(true),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    }
    const maintenance = { pruneMessageIndexBatch: jest.fn().mockResolvedValue({ scanned: 0, removed: 0 }) }
    ;(service as any).leaseFactory = jest.fn().mockReturnValue(lease)
    ;(service as any).maintenance = maintenance

    await service.connect(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(lease.acquire).toHaveBeenCalledTimes(1)
    expect(maintenance.pruneMessageIndexBatch).toHaveBeenCalledWith(phone)

    await service.disconnect()
    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  test('does not create a second Zapo socket when another worker owns the Redis session', async () => {
    config.useRedis = true
    const lease = {
      acquire: jest.fn().mockResolvedValue(false),
      renew: jest.fn(),
      release: jest.fn(),
    }
    ;(service as any).leaseFactory = jest.fn().mockReturnValue(lease)

    await expect(service.connect(1)).rejects.toMatchObject({ code: 409 })
    expect(client.connect).not.toHaveBeenCalled()
    expect(lease.release).not.toHaveBeenCalled()
  })

  test('disconnects conservatively when Redis session ownership can no longer be confirmed', async () => {
    config.useRedis = true
    const lease = {
      acquire: jest.fn().mockResolvedValue(true),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    }
    ;(service as any).leaseFactory = jest.fn().mockReturnValue(lease)
    ;(service as any).maintenance = { pruneMessageIndexBatch: jest.fn().mockResolvedValue({ scanned: 0, removed: 0 }) }
    await service.connect(1)

    await (service as any).handleRuntimeOwnershipLoss('lease_renewal_failed', new Error('redis_down'))

    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(sessionStore.setStatus).toHaveBeenLastCalledWith(phone, 'offline')
  })

  test('rejects incoming calls through the official VoIP plugin and sends the configured reply', async () => {
    config.rejectCalls = 'Não atendemos chamadas por aqui.'
    config.messageCallsWebhook = 'Chamada recebida'
    await service.connect(1)

    await handlers.voip_call_incoming({
      callId: 'call-1',
      peerJid: '5511@s.whatsapp.net',
      callerPn: '5522@s.whatsapp.net',
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(client.voip.rejectCall).toHaveBeenCalledWith('call-1')
    expect(client.message.send).toHaveBeenCalledWith('5522@s.whatsapp.net', {
      type: 'text', text: 'Não atendemos chamadas por aqui.',
    })
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({ remoteJid: '5522@s.whatsapp.net' }),
      message: { conversation: 'Chamada recebida' },
    })], 'notify')
  })

  test('downloads incoming media through the official Zapo coordinator as a raw storage buffer', async () => {
    client.message.downloadBytes.mockResolvedValue(Uint8Array.from([1, 2, 3]))
    let normalized: any
    listener.process.mockImplementation(async (_phone, messages) => {
      normalized = await service.getMessageMetadata(messages[0])
    })
    await service.connect(1)

    await handlers.message({
      key: { id: 'media-1', remoteJid: '111@lid', fromMe: false, isNewsletter: false },
      timestampSeconds: 1,
      message: { imageMessage: { mimetype: 'image/jpeg', directPath: '/media' } },
    })

    expect(client.message.downloadBytes).toHaveBeenCalled()
    expect(normalized.__unoapiMediaBytes).toEqual(Buffer.from([1, 2, 3]))
    expect(normalized.message.imageMessage.url).toBeUndefined()
  })

  test('bridges the official Zapo passkey signer to the existing Uno assertion endpoint', async () => {
    await service.connect(1)
    const options = (service as any).clientFactory.mock?.calls?.[0]?.[0]
      || (client as any)
    const factoryOptions = (service as any).clientFactory.mock.calls[0][0]
    const assertion = factoryOptions.signPasskeyAssertion(Uint8Array.from([7, 8]))
    await new Promise((resolve) => setImmediate(resolve))

    await expect(service.sendPasskeyResponse({
      credentialId: Buffer.from([1, 2]),
      assertionJson: '{"authenticatorData":"x"}',
    })).resolves.toEqual(expect.objectContaining({ ok: expect.objectContaining({ success: true }) }))
    await expect(assertion).resolves.toEqual({
      credentialId: Uint8Array.from([1, 2]),
      webauthnAssertion: Uint8Array.from(Buffer.from('{"authenticatorData":"x"}')),
    })
    await expect(service.sendPasskeyConfirmation()).resolves.toEqual({
      ok: { success: true, provider_managed_confirmation: true },
    })
    expect(options).toBeDefined()
  })
})
