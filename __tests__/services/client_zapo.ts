/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('@zapo-js/voip', () => ({
  voipPlugin: jest.fn().mockReturnValue({ name: 'voip' }),
}))
jest.mock('@zapo-js/media-utils', () => ({
  createMediaProcessor: jest.fn().mockReturnValue({ process: jest.fn() }),
}))
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
import { proto, type WaClient, type WaStore, type WaStoreSession } from 'zapo-js'
import { ClientZapo } from '../../src/services/client_zapo'
import { clients } from '../../src/services/client'
import { defaultConfig } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import type { Listener } from '../../src/services/listener'
import type { SessionStore } from '../../src/services/session_store'
import type { Store } from '../../src/services/store'
import { ensureZapoSessionMigration } from '../../src/services/zapo/zapo_migration'
import { updatePasskeyBridgeSession } from '../../src/services/passkey_bridge'

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
    expect((service as any).clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      history: { enabled: true, requireFullSync: true },
      media: expect.objectContaining({
        processor: expect.any(Object),
        generateWaveform: true,
        normalizeVoiceNote: true,
      }),
    }))
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining([
      'auth_qr',
      'connection',
      'message',
      'receipt',
      'picture',
      'voip_call_incoming',
    ]))
  })

  test('releases the socket when connection fails after the QR prompt was emitted', async () => {
    let rejectConnect: (error: Error) => void = () => undefined
    client.connect.mockReturnValue(new Promise<void>((_resolve, reject) => {
      rejectConnect = reject
    }))

    const connecting = service.connect(1)
    await new Promise((resolve) => setImmediate(resolve))
    handlers.auth_qr({ qr: 'qr-after-connect-start' })
    await connecting

    rejectConnect(new Error('handshake failed'))
    await new Promise((resolve) => setImmediate(resolve))

    expect((service as any).socket).toBeUndefined()
    expect((service as any).messages).toBeUndefined()
    expect(sessionStore.setStatus).toHaveBeenLastCalledWith(phone, 'offline')
    await service.disconnect()
  })

  test('returns control when the server requests a passkey signer', async () => {
    client.connect.mockReturnValue(new Promise<void>(() => undefined))

    const connecting = service.connect(1)
    await new Promise((resolve) => setImmediate(resolve))
    handlers.auth_passkey_required({ hasSigner: true })

    await expect(connecting).resolves.toBeUndefined()
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: { conversation: 'zapo_passkey_signer_ready' },
    })], 'status')
    await service.disconnect()
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
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: { conversation: `Connected with ${phone} using Zapo` },
    })], 'status')
    expect(listener.process).toHaveBeenCalledWith(phone, expect.any(Array), 'notify')
    expect(listener.process).toHaveBeenCalledWith(phone, expect.any(Array), 'update')
    expect(dataStore.setGroupMetada).toHaveBeenCalledWith('120363@g.us', expect.objectContaining({ subject: 'Equipe' }))
  })

  test('marks incoming messages as read on receipt when configured', async () => {
    config.readOnReceipt = true
    await service.connect(1)

    const event = {
      key: { id: 'incoming-read-1', remoteJid: '111@lid', fromMe: false, isNewsletter: false },
      timestampSeconds: 1,
      message: { conversation: 'oi' },
    }
    await handlers.message(event)

    expect(client.message.sendReceipt).toHaveBeenCalledWith(event, { type: 'read' })
  })

  test('does not lose an incoming message when the optional read receipt fails', async () => {
    config.readOnReceipt = true
    client.message.sendReceipt.mockRejectedValue(new Error('receipt unavailable'))
    await service.connect(1)

    await expect(handlers.message({
      key: { id: 'incoming-read-failure', remoteJid: '111@lid', fromMe: false, isNewsletter: false },
      timestampSeconds: 1,
      message: { conversation: 'oi' },
    })).resolves.toBeUndefined()

    expect(listener.process).toHaveBeenCalledWith(phone, expect.any(Array), 'notify')
  })

  test('forwards persisted Zapo history inside the configured day window', async () => {
    const now = Date.now()
    config.ignoreHistoryMessages = false
    config.historyMaxAgeDays = 7
    session.threads.list.mockResolvedValue([{ jid: '111@lid' }])
    session.messages.listByThread.mockResolvedValue([{
      id: 'history-zapo-1',
      threadJid: '111@lid',
      fromMe: false,
      timestampMs: now - 24 * 60 * 60 * 1_000,
      messageBytes: proto.Message.encode({ conversation: 'histórico' }).finish(),
    }])
    await service.connect(1)

    await handlers.history_sync_chunk({
      progress: 100,
      messagesCount: 1,
      conversationsCount: 1,
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({ id: 'history-zapo-1', remoteJid: '111@lid' }),
      message: expect.objectContaining({ conversation: 'histórico' }),
    })], 'history')
  })

  test('replays persisted history on demand without requesting a new QR code', async () => {
    const now = Date.now()
    session.threads.list.mockResolvedValue([{ jid: '111@lid' }])
    session.messages.listByThread.mockResolvedValue([{
      id: 'history-replay-1',
      threadJid: '111@lid',
      fromMe: false,
      timestampMs: now,
      messageBytes: proto.Message.encode({ conversation: 'replay' }).finish(),
    }])
    await service.connect(1)

    await expect(service.fetchMessageHistory({
      replay_stored: true,
      force_replay: true,
      days: 3,
    })).resolves.toEqual({ forwarded: 1 })

    expect(client.message.requestHistorySync).not.toHaveBeenCalled()
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({ id: 'history-replay-1' }),
    })], 'history')
  })

  test('waits for the final Zapo history chunk before forwarding persisted messages', async () => {
    config.ignoreHistoryMessages = false
    session.threads.list.mockResolvedValue([])
    await service.connect(1)

    await handlers.history_sync_chunk({ progress: 60, messagesCount: 1, conversationsCount: 1 })
    expect(session.threads.list).not.toHaveBeenCalled()

    await handlers.history_sync_chunk({ progress: 100, messagesCount: 1, conversationsCount: 1 })
    expect(session.threads.list).toHaveBeenCalledTimes(1)
  })

  test('retries persisted history when the listener fails before delivery confirmation', async () => {
    config.ignoreHistoryMessages = false
    session.threads.list.mockResolvedValue([{ jid: '111@lid' }])
    session.messages.listByThread.mockResolvedValue([{
      id: 'history-retry-1',
      threadJid: '111@lid',
      fromMe: false,
      timestampMs: Date.now(),
      messageBytes: proto.Message.encode({ conversation: 'tentar novamente' }).finish(),
    }])
    listener.process.mockRejectedValueOnce(new Error('webhook unavailable')).mockResolvedValue(undefined)
    await service.connect(1)

    await handlers.history_sync_chunk({ progress: 100, messagesCount: 1, conversationsCount: 1 })
    await handlers.history_sync_chunk({ progress: 100, messagesCount: 1, conversationsCount: 1 })

    expect(listener.process).toHaveBeenCalledTimes(2)
  })

  test('forwards unavailable view-once messages as an explicit placeholder', async () => {
    await service.connect(1)

    await handlers.message_unavailable({
      key: { id: 'view-once-1', remoteJid: '111@lid', fromMe: false },
      kind: 'view_once',
      timestampSeconds: 10,
      pushName: 'Contato',
    })

    expect(dataStore.setKey).toHaveBeenCalledWith(
      'view-once-1',
      expect.objectContaining({ remoteJid: '111@lid' }),
    )
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      messageStubParameters: ['view_once_unavailable'],
    })], 'notify')
  })

  test('does not misclassify other unavailable placeholders as view-once', async () => {
    await service.connect(1)

    await handlers.message_unavailable({
      key: { id: 'hosted-1', remoteJid: '111@lid', fromMe: false },
      kind: 'hosted',
    })

    expect(listener.process).not.toHaveBeenCalled()
  })

  test('seeds the exact Zapo PN and LID mappings from group metadata', async () => {
    client.group.queryAllGroups.mockResolvedValue([{
      id: '120363@g.us',
      subject: 'Equipe',
      participants: [{
        jid: '86110369755163@lid',
        phoneNumber: '556696328386@s.whatsapp.net',
      }],
    }] as never)
    await service.connect(1)

    await handlers.connection({ status: 'open', isNewLogin: false })
    await new Promise((resolve) => setImmediate(resolve))

    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      phone,
      '556696328386@s.whatsapp.net',
      '86110369755163@lid',
    )
  })

  test('enriches group messages with the subject cached in Redis', async () => {
    dataStore.getGroupMetada.mockResolvedValue({
      id: '120363363045088699@g.us',
      subject: 'Grupo correto',
      participants: [],
    })
    await service.connect(1)

    const message = await service.getMessageMetadata({
      key: { id: 'group-cached', remoteJid: '120363363045088699@g.us' },
      message: { conversation: 'mensagem' },
    })

    expect(message).toEqual(expect.objectContaining({
      groupMetadata: expect.objectContaining({ subject: 'Grupo correto' }),
    }))
    expect(client.group.queryGroupMetadata).not.toHaveBeenCalledWith('120363363045088699@g.us')
  })

  test('queries and caches group metadata before the webhook when Redis is cold', async () => {
    dataStore.getGroupMetada.mockResolvedValue(undefined)
    client.group.queryGroupMetadata.mockResolvedValue({
      id: '120363363045088699@g.us',
      subject: 'Grupo recuperado',
      participants: [],
    } as never)
    await service.connect(1)

    const message = await service.getMessageMetadata({
      key: { id: 'group-cold', remoteJid: '120363363045088699@g.us' },
      message: { conversation: 'mensagem offline' },
    })

    expect(message).toEqual(expect.objectContaining({
      groupMetadata: expect.objectContaining({ subject: 'Grupo recuperado' }),
    }))
    expect(dataStore.setGroupMetada).toHaveBeenCalledWith(
      '120363363045088699@g.us',
      expect.objectContaining({ subject: 'Grupo recuperado' }),
    )
  })

  test('persists complete Zapo credentials when pairing finishes', async () => {
    const credentials = { meJid: `${phone}@s.whatsapp.net` } as never
    await service.connect(1)

    await handlers.auth_paired({ credentials })

    expect(session.auth.save).toHaveBeenCalledWith(credentials)
  })

  test('marks the Zapo passkey bridge completed only after auth_paired', async () => {
    await service.connect(1)
    const factoryOptions = (service as any).clientFactory.mock.calls[0][0]
    const assertion = factoryOptions.signPasskeyAssertion(Uint8Array.from([7, 8]))
    await new Promise((resolve) => setImmediate(resolve))
    const bridgeId = (service as any).pendingPasskey.bridgeId

    await service.sendPasskeyResponse({
      credentialId: Buffer.from([1, 2]),
      assertionJson: '{}',
    })
    await assertion
    expect(updatePasskeyBridgeSession).not.toHaveBeenCalledWith(bridgeId, { status: 'completed' })

    await handlers.auth_paired({ credentials: { meJid: '111@lid' } })
    expect(updatePasskeyBridgeSession).toHaveBeenCalledWith(bridgeId, { status: 'completed' })
  })

  test('forwards protocol messages such as edits and revokes', async () => {
    await service.connect(1)
    const event = {
      key: { id: 'protocol-1', remoteJid: '111@lid', fromMe: false },
      timestampSeconds: 10,
      message: { protocolMessage: { type: 0 } },
      protocolMessage: { type: 0 },
    }

    await handlers.message_protocol(event)

    expect(dataStore.setKey).toHaveBeenCalledWith('protocol-1', expect.objectContaining({ remoteJid: '111@lid' }))
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: event.message,
    })], 'notify')
  })

  test('moves the stored contact and Uno mapping when Zapo reports a LID rotation', async () => {
    session.contacts.getByJid.mockResolvedValue({
      jid: '111@lid',
      lid: '111@lid',
      phoneNumber: '5566111',
      lastUpdatedMs: 1,
    })
    await service.connect(1)

    await handlers.mex_notification({ kind: 'lid_change', oldLidJid: '111@lid', newLidJid: '222@lid' })

    expect(session.contacts.upsert).toHaveBeenCalledWith(expect.objectContaining({ jid: '222@lid', lid: '222@lid' }))
    expect(session.contacts.deleteByJid).toHaveBeenCalledWith('111@lid')
    expect(dataStore.setJidMapping).toHaveBeenCalledWith(phone, '5566111@s.whatsapp.net', '222@lid')
  })

  test('enriches a Zapo group sender LID with the stored phone number', async () => {
    session.contacts.getByJid.mockResolvedValue({ phoneNumber: '5566991112222' } as never)
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'group-1',
        remoteJid: '120363@g.us',
        participant: '123456789@lid',
        fromMe: false,
        isGroup: true,
        isNewsletter: false,
      },
      timestampSeconds: 1,
      message: { conversation: 'oi grupo' },
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({
        participant: '123456789@lid',
        participantAlt: '5566991112222@s.whatsapp.net',
      }),
    })], 'notify')
  })

  test('enriches the recipient of a phone-authored direct message from its LID', async () => {
    session.contacts.getByJid.mockResolvedValue({ phoneNumber: '5566991112222' } as never)
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'own-1',
        remoteJid: '123456789@lid',
        fromMe: true,
        isGroup: false,
        isNewsletter: false,
      },
      timestampSeconds: 1,
      message: { conversation: 'mensagem enviada pelo aparelho' },
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({
        remoteJid: '123456789@lid',
        remoteJidAlt: '5566991112222@s.whatsapp.net',
        fromMe: true,
      }),
    })], 'notify')
    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      phone,
      '5566991112222@s.whatsapp.net',
      '123456789@lid',
    )
  })

  test('enriches an incoming direct message when Zapo only provides its LID', async () => {
    session.contacts.getByJid.mockResolvedValue({ phoneNumber: '556699554300' } as never)
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'incoming-lid-only',
        remoteJid: '123456789@lid',
        fromMe: false,
        isGroup: false,
        isNewsletter: false,
      },
      timestampSeconds: 1,
      message: { conversation: 'primeiro contato' },
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({
        remoteJid: '123456789@lid',
        remoteJidAlt: '556699554300@s.whatsapp.net',
        fromMe: false,
      }),
    })], 'notify')
    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      phone,
      '556699554300@s.whatsapp.net',
      '123456789@lid',
    )
  })

  test('preserves an existing legacy recipient PN in the Zapo envelope', async () => {
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'own-legacy-pn',
        remoteJid: '11343495192601@lid',
        remoteJidAlt: '556699554300@s.whatsapp.net',
        fromMe: true,
        isGroup: false,
        isNewsletter: false,
      },
      timestampSeconds: 1,
      message: { conversation: 'eco pelo aparelho' },
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({
        remoteJidAlt: '556699554300@s.whatsapp.net',
      }),
    })], 'notify')
    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      phone,
      '556699554300@s.whatsapp.net',
      '11343495192601@lid',
    )
  })

  test('persists the canonical phone mapping learned from a Zapo receipt', async () => {
    session.contacts.getByJid.mockResolvedValue({ phoneNumber: '5566999554300' } as never)
    await service.connect(1)

    await handlers.receipt({
      messageIds: ['own-device-1'],
      chatJid: '11343495192601@lid',
      status: 'delivered',
      timestampMs: 2000,
    })

    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      phone,
      '5566999554300@s.whatsapp.net',
      '11343495192601@lid',
    )
  })

  test('filters individual and non-delivered group receipts according to session config', async () => {
    config.ignoreGroupIndividualReceipts = true
    config.groupOnlyDeliveredStatus = true
    await service.connect(1)

    await handlers.receipt({ messageIds: ['group-1'], chatJid: '120363@g.us', participantJid: '1@lid', status: 'delivered' })
    await handlers.receipt({ messageIds: ['group-1'], chatJid: '120363@g.us', status: 'read' })
    expect(listener.process).not.toHaveBeenCalledWith(phone, expect.any(Array), 'update')

    await handlers.receipt({ messageIds: ['group-1'], chatJid: '120363@g.us', status: 'delivered' })
    expect(listener.process).toHaveBeenCalledWith(phone, expect.any(Array), 'update')
  })

  test('delegates messages, contacts, history, privacy and app state operations', async () => {
    session.privacyToken.getByJid.mockResolvedValue({ token: Buffer.from('x') } as never)
    await service.connect(1)
    await handlers.connection({ status: 'open', isNewLogin: false })
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

  test('does not send while the Zapo socket is still pairing', async () => {
    await service.connect(1)

    await expect(service.send({ to: '5566111', type: 'text', text: { body: 'oi' } }, {}))
      .rejects.toThrow('zapo_client_not_connected')
    expect(client.message.send).not.toHaveBeenCalled()
  })

  test('releases ownership and rebuilds the socket after an unexpected close', async () => {
    jest.useFakeTimers()
    config.useRedis = true
    config.retryRequestDelayMs = 1_000
    const lease = {
      acquire: jest.fn().mockResolvedValue(true),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    }
    ;(service as any).leaseFactory = jest.fn().mockReturnValue(lease)
    ;(service as any).maintenance = { pruneMessageIndexBatch: jest.fn().mockResolvedValue({ scanned: 0, removed: 0 }) }
    await service.connect(1)

    await handlers.connection({ status: 'close', isLogout: false })

    expect(lease.release).toHaveBeenCalledTimes(1)
    expect((service as any).socket).toBeUndefined()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  test('disconnects and logs out without deleting migrated source credentials', async () => {
    await service.connect(1)
    await service.logout()
    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(sessionStore.setStatus).toHaveBeenLastCalledWith(phone, 'offline')
  })

  test('clears runtime ownership even when the Zapo socket disconnect fails', async () => {
    config.useRedis = true
    const lease = {
      acquire: jest.fn().mockResolvedValue(true),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    }
    ;(service as any).leaseFactory = jest.fn().mockReturnValue(lease)
    ;(service as any).maintenance = { pruneMessageIndexBatch: jest.fn().mockResolvedValue({ scanned: 0, removed: 0 }) }
    client.disconnect.mockRejectedValue(new Error('socket close failed'))
    await service.connect(1)

    await expect(service.disconnect()).rejects.toThrow('socket close failed')

    expect((service as any).socket).toBeUndefined()
    expect(lease.release).toHaveBeenCalledTimes(1)
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

  test('retries after a stale Zapo ownership lease expires', async () => {
    jest.useFakeTimers()
    config.useRedis = true
    config.retryRequestDelayMs = 1_000
    const lease = {
      acquire: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    }
    ;(service as any).leaseFactory = jest.fn().mockReturnValue(lease)
    ;(service as any).maintenance = { pruneMessageIndexBatch: jest.fn().mockResolvedValue({ scanned: 0, removed: 0 }) }

    await expect(service.connect(1)).rejects.toMatchObject({ code: 409 })
    await jest.advanceTimersByTimeAsync(1_000)

    expect(lease.acquire).toHaveBeenCalledTimes(2)
    expect(client.connect).toHaveBeenCalledTimes(1)
    await service.disconnect()
    jest.clearAllTimers()
    jest.useRealTimers()
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
