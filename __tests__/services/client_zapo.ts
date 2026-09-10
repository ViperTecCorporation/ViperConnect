/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('@vipertec/zapo-voip', () => ({
  voipPlugin: jest.fn().mockReturnValue({ name: 'voip' }),
}))
jest.mock('@zapo-js/media-utils', () => ({
  createMediaProcessor: jest.fn().mockReturnValue({ process: jest.fn() }),
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
jest.mock('../../src/services/zapo/zapo_poll_addon_decrypt', () => ({
  decryptZapoPollVoteWithJidFallback: jest.fn().mockResolvedValue(null),
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
import type { MediaStore } from '../../src/services/media_store'
import { updatePasskeyBridgeSession } from '../../src/services/passkey_bridge'
import { voipPlugin } from '@vipertec/zapo-voip'
import { zapoUsernameIndex } from '../../src/services/zapo/zapo_username_index'
import { decryptZapoPollVoteWithJidFallback } from '../../src/services/zapo/zapo_poll_addon_decrypt'
import { registerZapoStatePreparation } from '../../src/services/zapo/zapo_persistent_state'

describe('ClientZapo', () => {
  const phone = '5566999999999'
  let client: ReturnType<typeof mockDeep<WaClient>>
  let session: ReturnType<typeof mockDeep<WaStoreSession>>
  let sessionStore: ReturnType<typeof mockDeep<SessionStore>>
  let dataStore: ReturnType<typeof mockDeep<DataStore>>
  let listener: ReturnType<typeof mockDeep<Listener>>
  let mediaStore: ReturnType<typeof mockDeep<MediaStore>>
  let handlers: Record<string, (...args: any[]) => any>
  let service: ClientZapo
  let config: typeof defaultConfig

  const stubRedisOwnership = () => {
    ;(service as any).leaseFactory = jest.fn().mockReturnValue({
      acquire: jest.fn().mockResolvedValue(true),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    })
    ;(service as any).maintenance = {
      pruneMessageIndexBatch: jest.fn().mockResolvedValue({ scanned: 0, removed: 0 }),
    }
  }

  beforeEach(() => {
    clients.clear()
    jest.clearAllMocks()
    handlers = {}
    client = mockDeep<WaClient>()
    session = mockDeep<WaStoreSession>()
    sessionStore = mockDeep<SessionStore>()
    dataStore = mockDeep<DataStore>()
    listener = mockDeep<Listener>()
    mediaStore = mockDeep<MediaStore>()
    mediaStore.getFilePath.mockImplementation((_phone, mediaId) => `${phone}/${mediaId}.jpeg`)
    mediaStore.getFileUrl.mockImplementation(async (filePath) => `https://s3.example.test/${filePath}`)
    mediaStore.saveMediaBuffer.mockResolvedValue(true)
    sessionStore.isStatusOnline.mockResolvedValue(false)
    client.on.mockImplementation(((event: string, handler: (...args: any[]) => any) => {
      handlers[event] = handler
      return client
    }) as never)
    client.connect.mockResolvedValue(undefined)
    client.message.send.mockResolvedValue({ id: 'zapo-message-1' } as never)
    client.profile.getLidsByPhoneNumbers.mockResolvedValue([
      {
        queriedJid: '5566111@s.whatsapp.net',
        exists: true,
        phoneJid: '5566111@s.whatsapp.net',
        lidJid: '111@lid',
        invalid: false,
      },
    ] as never)
    client.profile.resolveUsername.mockResolvedValue({ status: 'not-found' } as never)
    jest.mocked(decryptZapoPollVoteWithJidFallback).mockResolvedValue(null)
    client.message.requestHistorySync.mockResolvedValue({ messageId: 'history-1' } as never)
    client.auth.requestPairingCode.mockResolvedValue('1234-5678')
    client.group.queryAllGroups.mockResolvedValue([])
    client.group.queryGroupMetadata.mockResolvedValue({ id: '120363@g.us', subject: 'Equipe' } as never)
    const unoStore = { sessionStore, dataStore, mediaStore } as unknown as Store
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

  afterEach(async () => {
    await service?.disconnect().catch(() => undefined)
    jest.clearAllTimers()
    jest.useRealTimers()
    clients.clear()
  })

  test('waits for existing key persistence before loading auth or connecting', async () => {
    let finish!: (result: [string, string[]]) => void
    const scan = jest.fn().mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const store = (service as any).storeRegistry.get(config)
    registerZapoStatePreparation(store, { scan } as any, 'unoapi:zapo:')
    const connecting = service.connect(1)
    while (!scan.mock.calls.length) await new Promise((resolve) => setImmediate(resolve))
    expect(session.auth.load).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
    finish(['0', []])
    await connecting
    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  test('online starts the presence pulse and disconnect stops it', async () => {
    jest.useFakeTimers()
    config.markOnlineOnConnect = false
    await service.connect(1)
    expect(client.presence.send).not.toHaveBeenCalled()
    await handlers.connection({ status: 'open' })
    await jest.advanceTimersByTimeAsync(0)
    expect(client.presence.send).toHaveBeenCalledWith('available')
    expect(client.presence.send).toHaveBeenCalledWith('unavailable')
    await service.disconnect()
    client.presence.send.mockClear()
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(client.presence.send).not.toHaveBeenCalled()
  })

  test.each([false, true])('connection close stops presence (isLogout=%s)', async (isLogout) => {
    jest.useFakeTimers()
    await service.connect(1)
    await handlers.connection({ status: 'open' })
    await jest.advanceTimersByTimeAsync(0)
    await handlers.connection({ status: 'close', isLogout })
    client.presence.send.mockClear()
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(client.presence.send).not.toHaveBeenCalled()
  })

  test('disconnect cancels a pending connect so a fresh attempt can generate QR', async () => {
    client.connect.mockReturnValueOnce(new Promise(() => undefined))
    const first = service.connect(1)
    const rejected = expect(first).rejects.toThrow('zapo_operation_cancelled')
    while (!handlers.auth_qr) await new Promise((resolve) => setImmediate(resolve))
    await service.disconnect()
    await rejected
    await service.connect(1)
    expect(client.connect).toHaveBeenCalledTimes(2)
  })

  test('a close event releases the pending handshake before reconnecting', async () => {
    client.connect.mockReturnValueOnce(new Promise(() => undefined))
    const first = service.connect(1)
    const rejected = expect(first).rejects.toThrow('zapo_operation_cancelled')
    while (!handlers.connection) await new Promise((resolve) => setImmediate(resolve))
    await handlers.connection({ status: 'close', isLogout: false })
    await rejected
    await service.connect(1)
    expect(client.connect).toHaveBeenCalledTimes(2)
  })

  test('logout invalidates the old socket so manual pairing cannot reuse it', async () => {
    await service.connect(1)
    await handlers.connection({ status: 'close', isLogout: true })
    await expect(service.requestPairingCode()).rejects.toThrow('zapo_client_not_connected')
    await service.connect(1)
    await expect(service.requestPairingCode()).resolves.toBe('1234-5678')
    expect(client.connect).toHaveBeenCalledTimes(2)
  })

  test('times out a stuck connection and allows another attempt', async () => {
    jest.useFakeTimers()
    client.connect.mockReturnValueOnce(new Promise(() => undefined))
    const first = service.connect(1)
    const rejected = expect(first).rejects.toThrow('zapo_connection_prompt_timeout')
    await jest.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(client.disconnect).toHaveBeenCalled()
    await service.connect(1)
    expect(client.connect).toHaveBeenCalledTimes(2)
  })

  test('a timed-out pairing request does not block the next code request', async () => {
    jest.useFakeTimers()
    await service.connect(1)
    client.auth.requestPairingCode.mockReturnValueOnce(new Promise(() => undefined))
    const rejected = expect(service.requestPairingCode()).rejects.toThrow('zapo_pairing_code_timeout')
    await jest.advanceTimersByTimeAsync(30_000)
    await rejected
    await expect(service.requestPairingCode()).resolves.toBe('1234-5678')
  })

  test('requires a full history sync when connecting a new Zapo pairing', async () => {
    session.auth.load.mockResolvedValue(null)

    await service.connect(1)

    expect(session.auth.load).toHaveBeenCalledTimes(1)
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect((service as any).clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      history: { enabled: true, requireFullSync: true },
      addons: { autoDecrypt: false },
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
    expect(voipPlugin).toHaveBeenCalledWith({
      maxConcurrentCalls: expect.any(Number),
      logLevel: 'debug',
    })
  })

  test('reuses native Zapo credentials without requesting pairing history again', async () => {
    session.auth.load.mockResolvedValue({ meJid: `${phone}@s.whatsapp.net` } as never)

    await service.connect(1)

    expect((service as any).clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      history: { enabled: true, requireFullSync: false },
    }))
    expect(client.connect).toHaveBeenCalledTimes(1)
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

  test('enriches an incoming webhook message with a username cached by LID', async () => {
    const lookup = jest.spyOn(zapoUsernameIndex, 'resolveByLid').mockResolvedValue('raulasalazart')
    config.useRedis = true
    stubRedisOwnership()
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'username-cache-1',
        remoteJid: '149396209594612@lid',
        remoteJidAlt: '573106677588@s.whatsapp.net',
        fromMe: false,
        isNewsletter: false,
      },
      timestampSeconds: 1,
      message: { conversation: 'oi' },
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({ senderUsername: 'raulasalazart' }),
    })], 'notify')
    expect(lookup).toHaveBeenCalledWith(phone, '149396209594612@lid', expect.any(Number), false)
    lookup.mockRestore()
  })

  test('learns the peer recipientUsername from a self-authored direct message', async () => {
    const touch = jest.spyOn(zapoUsernameIndex, 'touch').mockResolvedValue()
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'username-recipient-1',
        remoteJid: '149396209594612@lid',
        remoteJidAlt: '573106677588@s.whatsapp.net',
        recipientUsername: 'cliente.teste',
        fromMe: true,
        isGroup: false,
        isNewsletter: false,
      },
      timestampSeconds: 1,
      message: { conversation: 'oi' },
    })

    expect(touch).toHaveBeenCalledWith(phone, 'cliente.teste', '149396209594612@lid')
    touch.mockRestore()
  })

  test('learns participantUsername from group receipts', async () => {
    const touch = jest.spyOn(zapoUsernameIndex, 'touch').mockResolvedValue()
    await service.connect(1)

    await handlers.receipt({
      messageIds: ['group-username-1'],
      chatJid: '120363@g.us',
      participantJid: '149396209594612@lid',
      participantUsername: 'cliente.grupo',
      status: 'delivered',
      timestampMs: 2_000,
    })

    expect(touch).toHaveBeenCalledWith(phone, 'cliente.grupo', '149396209594612@lid')
    touch.mockRestore()
  })

  test('keeps the official own_username event in the temporal index', async () => {
    const touch = jest.spyOn(zapoUsernameIndex, 'touch').mockResolvedValue()
    session.auth.load.mockResolvedValue({ meJid: `${phone}@s.whatsapp.net`, meLid: '999@lid' } as never)
    await service.connect(1)

    await handlers.own_username({ kind: 'set', username: 'empresa.oficial' })

    expect(touch).toHaveBeenCalledWith(phone, 'empresa.oficial', '999@lid')
    touch.mockRestore()
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

  test('forwards the decrypted poll addon without also forwarding its encrypted placeholder', async () => {
    await service.connect(1)
    client.message.tryDecryptAddon.mockImplementation(async (event: any) => {
      await handlers.message_addon({
        key: event.key,
        targetMessageId: 'poll-parent-1',
        kind: 'poll_vote',
        decrypted: {
          kind: 'poll_vote',
          pollVote: {},
          selectedOptionNames: ['Zapo'],
        },
      })
    })

    await handlers.message({
      key: {
        id: 'poll-vote-1',
        remoteJid: '120363@g.us',
        participant: '94047083475061@lid',
        fromMe: true,
        isGroup: true,
        isNewsletter: false,
      },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: 'poll-parent-1' },
          vote: { encPayload: Uint8Array.from([1]), encIv: Uint8Array.from([2]) },
        },
      },
    })

    expect(client.message.tryDecryptAddon).toHaveBeenCalledTimes(1)
    expect(decryptZapoPollVoteWithJidFallback).not.toHaveBeenCalled()
    expect(listener.process).toHaveBeenCalledTimes(1)
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: {
        pollUpdateMessage: expect.objectContaining({
          vote: expect.objectContaining({ selectedOptionNames: ['Zapo'] }),
        }),
      },
    })], 'notify')
  })

  test('uses the legacy poll decryptor only after the official Zapo path produces no addon', async () => {
    jest.mocked(decryptZapoPollVoteWithJidFallback).mockResolvedValue({
      key: {
        id: 'poll-vote-legacy-1',
        remoteJid: '120363@g.us',
        participant: '94047083475061@lid',
        fromMe: false,
        isGroup: true,
        isNewsletter: false,
      },
      targetMessageId: 'poll-parent-1',
      kind: 'poll_vote',
      decrypted: {
        kind: 'poll_vote',
        pollVote: {},
        selectedOptionNames: ['Fallback'],
      },
    } as never)
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'poll-vote-legacy-1',
        remoteJid: '120363@g.us',
        participant: '94047083475061@lid',
        fromMe: false,
        isGroup: true,
        isNewsletter: false,
      },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: 'poll-parent-1' },
          vote: { encPayload: Uint8Array.from([1]), encIv: Uint8Array.from([2]) },
        },
      },
    })

    expect(client.message.tryDecryptAddon).toHaveBeenCalledTimes(1)
    expect(decryptZapoPollVoteWithJidFallback).toHaveBeenCalledTimes(1)
    expect(listener.process).toHaveBeenCalledWith(
      phone,
      [
        expect.objectContaining({
          message: {
            pollUpdateMessage: expect.objectContaining({
              vote: expect.objectContaining({ selectedOptionNames: ['Fallback'] }),
            }),
          },
        }),
      ],
      'notify',
    )
  })

  test('keeps the encrypted poll update as a fallback when Zapo emits no addon', async () => {
    await service.connect(1)

    await handlers.message({
      key: {
        id: 'poll-vote-fallback-1',
        remoteJid: '120363@g.us',
        participant: '94047083475061@lid',
        fromMe: true,
        isGroup: true,
        isNewsletter: false,
      },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: 'poll-parent-1' },
          vote: { encPayload: Uint8Array.from([1]), encIv: Uint8Array.from([2]) },
        },
      },
    })

    expect(client.message.tryDecryptAddon).toHaveBeenCalledTimes(1)
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({ id: 'poll-vote-fallback-1' }),
    })], 'notify')
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

  test('forwards unavailable hosted messages as an explicit integration placeholder', async () => {
    await service.connect(1)

    await handlers.message_unavailable({
      key: { id: 'hosted-1', remoteJid: '111@lid', fromMe: false },
      kind: 'hosted',
      timestampSeconds: 11,
      pushName: 'Contato oficial',
    })

    expect(dataStore.setKey).toHaveBeenCalledWith(
      'hosted-1',
      expect.objectContaining({ remoteJid: '111@lid' }),
    )
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      messageStubParameters: ['hosted_message_unavailable'],
    })], 'notify')
  })

  test('waits for the recovered message when Zapo requested a placeholder resend', async () => {
    await service.connect(1)

    await handlers.message_unavailable({
      key: { id: 'other-1', remoteJid: '111@lid', fromMe: false },
      kind: 'other',
      resendRequested: true,
    })

    expect(listener.process).not.toHaveBeenCalled()
  })

  test.each(['other', 'bot'] as const)('forwards unrecoverable %s placeholders to the integration', async (kind) => {
    await service.connect(1)

    await handlers.message_unavailable({
      key: { id: `${kind}-1`, remoteJid: '111@lid', fromMe: false },
      kind,
      resendRequested: false,
    })

    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      messageStubParameters: ['hosted_message_unavailable'],
    })], 'notify')
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

  test('replaces the QR prompt with a readable pairing-code image in pairing-code mode', async () => {
    config.connectionType = 'pairing_code'
    client.auth.requestPairingCode.mockImplementation(async () => {
      await handlers.auth_pairing_code({ code: '1234-5678' })
      return '1234-5678'
    })
    await service.connect(1)

    await handlers.auth_qr({ qr: 'qr-must-not-be-forwarded' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(client.auth.requestPairingCode).toHaveBeenCalledWith(phone)
    expect(listener.process).toHaveBeenCalledTimes(1)
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: {
        imageMessage: expect.objectContaining({
          url: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
          mimetype: 'image/svg+xml',
          caption: 'Zapo pairing code',
        }),
      },
    })], 'qrcode')
  })

  test('keeps forwarding the native QR image in QR-code mode', async () => {
    config.connectionType = 'qrcode'
    await service.connect(1)
    let resolveQrForwarded = () => undefined
    const qrForwarded = new Promise<void>((resolve) => {
      resolveQrForwarded = resolve
    })
    listener.process.mockImplementation(async () => {
      resolveQrForwarded()
    })

    await handlers.auth_qr({ qr: 'native-zapo-qr' })
    await qrForwarded

    expect(client.auth.requestPairingCode).not.toHaveBeenCalled()
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: {
        imageMessage: expect.objectContaining({
          url: expect.stringMatching(/^data:image\/png;base64,/),
          mimetype: 'image/png',
          caption: 'Zapo pairing',
        }),
      },
    })], 'qrcode')
  })

  test('ignores stale QR events after disconnect while accepting a genuine reconnect', async () => {
    config.connectionType = 'qrcode'
    await service.connect(1)
    const staleQrHandler = handlers.auth_qr

    await service.disconnect()
    listener.process.mockClear()
    await staleQrHandler({ qr: 'stale-qr-after-disconnect' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(listener.process).not.toHaveBeenCalled()

    await service.connect(1)
    const currentQrHandler = handlers.auth_qr
    let resolveCurrentQr = () => undefined
    const currentQr = new Promise<void>((resolve) => {
      resolveCurrentQr = resolve
    })
    listener.process.mockImplementation(async () => {
      resolveCurrentQr()
    })
    await currentQrHandler({ qr: 'current-qr-after-reconnect' })
    await currentQr

    expect(listener.process).toHaveBeenCalledTimes(1)
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      message: {
        imageMessage: expect.objectContaining({
          caption: 'Zapo pairing',
          mimetype: 'image/png',
        }),
      },
    })], 'qrcode')
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
    const touch = jest.spyOn(zapoUsernameIndex, 'touch').mockResolvedValue()
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
    expect(touch).not.toHaveBeenCalled()
    touch.mockRestore()
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
    session.contacts.getByJid.mockResolvedValueOnce({
      jid: '111@lid',
      lid: '111@lid',
      phoneNumber: '5566111',
      displayName: 'Amor Vida',
      pushName: 'Amor',
      lastUpdatedMs: 1,
    })
    await expect(service.contacts(['5566111', 'invalid'])).resolves.toEqual([
      expect.objectContaining({
        status: 'valid',
        wa_id: '5566111',
        user_id: '111@lid',
        display_name: 'Amor Vida',
        push_name: 'Amor',
      }),
      expect.objectContaining({ status: 'invalid' }),
    ])
    session.contacts.getByJid.mockResolvedValueOnce({
      jid: '111@lid',
      lid: '111@lid',
      phoneNumber: '5566111',
      lastUpdatedMs: 1,
    })
    await expect(service.saveContact({
      phone_number: '5566111',
      full_name: 'Amor Vida',
      user_id: '111@lid',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      contact: expect.objectContaining({ phone_number: '5566111', user_id: '111@lid' }),
    }))
    expect(client.chat.set).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'Contact',
      id: '5566111@s.whatsapp.net',
      fullName: 'Amor Vida',
    }))
    await expect(service.fetchMessageHistory({ count: 5 })).resolves.toEqual({ request_id: 'history-1' })
    await expect(service.fetchPrivacyTokens(['5566111@s.whatsapp.net'])).resolves.toEqual(expect.objectContaining({ stored: 1 }))
    await expect(service.requestPairingCode()).resolves.toBe('1234-5678')
    expect(client.auth.requestPairingCode).toHaveBeenCalledWith(phone)
    await service.resyncAppState()
    expect(client.chat.sync).toHaveBeenCalledTimes(1)
  })

  test('includes a cached username in numeric contact verification', async () => {
    const lookup = jest.spyOn(zapoUsernameIndex, 'resolveByLid').mockResolvedValue('raulasalazart')
    config.useRedis = true
    stubRedisOwnership()
    session.contacts.getByJid.mockResolvedValue({
      jid: '111@lid',
      lid: '111@lid',
      phoneNumber: '5566111',
      displayName: 'Raul',
      lastUpdatedMs: 1,
    } as never)
    await service.connect(1)

    await expect(service.contacts(['5566111'])).resolves.toEqual([
      expect.objectContaining({
        wa_id: '5566111',
        user_id: '111@lid',
        username: 'raulasalazart',
      }),
    ])
    expect(lookup).toHaveBeenCalledWith(phone, '111@lid', expect.any(Number), false)
    lookup.mockRestore()
  })

  test('resolves an uncached username through the official Zapo profile coordinator', async () => {
    const lookup = jest.spyOn(zapoUsernameIndex, 'resolve').mockResolvedValue(undefined)
    const touch = jest.spyOn(zapoUsernameIndex, 'touch').mockResolvedValue()
    client.profile.resolveUsername.mockResolvedValue({
      status: 'found',
      jid: '149396209594612@lid',
      username: 'cliente.teste',
      isBusiness: true,
      pnJid: '573106677588@s.whatsapp.net',
    } as never)
    session.contacts.getByJid.mockResolvedValue(undefined)
    await service.connect(1)

    await expect(service.contacts(['@cliente.teste'])).resolves.toEqual([
      expect.objectContaining({
        input: '@cliente.teste',
        user_id: '149396209594612@lid',
        username: 'cliente.teste',
        status: 'valid',
      }),
    ])
    expect(client.profile.resolveUsername).toHaveBeenCalledWith({ username: '@cliente.teste' })
    expect(touch).toHaveBeenCalledWith(phone, 'cliente.teste', '149396209594612@lid')
    expect(session.contacts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: '149396209594612@lid',
        phoneNumber: '573106677588',
        username: 'cliente.teste',
      }),
    )
    lookup.mockRestore()
    touch.mockRestore()
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

  test('registers an orphaned reconnecting client again when its socket opens', async () => {
    await service.connect(1)
    clients.delete(phone)

    await handlers.connection({ status: 'open', isNewLogin: false })

    expect(clients.get(phone)).toBe(service)
  })

  test('disconnects and logs out without touching the isolated Baileys rollback credentials', async () => {
    await service.connect(1)
    await service.logout()
    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(sessionStore.setStatus).toHaveBeenLastCalledWith(phone, 'offline')
    expect((service as any).socket).toBeUndefined()
    expect((service as any).messages).toBeUndefined()
  })

  test('treats logout without a local socket as an idempotent disconnect', async () => {
    await expect(service.logout()).resolves.toBeUndefined()

    expect(client.logout).not.toHaveBeenCalled()
    expect((service as any).socket).toBeUndefined()
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

  test('bounds replay deduplication state and clears it on disconnect', async () => {
    const forwardedHistoryIds = (service as any).forwardedHistoryIds
    for (let index = 0; index <= 100_000; index += 1) {
      forwardedHistoryIds.add(`message-${index}`)
    }

    expect(forwardedHistoryIds.size).toBe(100_000)
    expect(forwardedHistoryIds.has('message-0')).toBe(false)
    expect(forwardedHistoryIds.has('message-100000')).toBe(true)

    await service.connect(1)
    await service.disconnect()

    expect(forwardedHistoryIds.size).toBe(0)
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
    clients.set(phone, service)

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

  test('keeps configured automatic call rejection ahead of the connected VoIP bridge', async () => {
    config.rejectCalls = 'Não atendemos chamadas por aqui.'
    config.rejectCallsWebhook = 'Tentou ligar no WhatsApp'
    await service.connect(1)
    const voiceBridge = { publishIncoming: jest.fn().mockReturnValue(true) }
    ;(service as any).voiceBridge = voiceBridge

    await handlers.voip_call_incoming({
      callId: 'call-auto-reject',
      peerJid: '5511@s.whatsapp.net',
      callerPn: '5522@s.whatsapp.net',
    })

    expect(client.voip.rejectCall).toHaveBeenCalledWith('call-auto-reject')
    expect(client.message.send).toHaveBeenCalledWith('5522@s.whatsapp.net', {
      type: 'text', text: 'Não atendemos chamadas por aqui.',
    })
    expect(voiceBridge.publishIncoming).not.toHaveBeenCalled()
    expect(listener.process).toHaveBeenCalledWith(phone, [expect.objectContaining({
      key: expect.objectContaining({ __unoapiSkipTypebot: true }),
      message: { conversation: 'Tentou ligar no WhatsApp' },
    })], 'notify')
  })

  test('resolves an incoming call LID to its phone number before forwarding the call identity', async () => {
    config.rejectCalls = 'Não atendemos chamadas por aqui.'
    session.contacts.getByJid.mockResolvedValue({
      jid: '11343495192601@lid',
      lid: '11343495192601@lid',
      phoneNumber: '5566996269251',
    } as never)
    await service.connect(1)

    await handlers.voip_call_incoming({
      callId: 'call-lid',
      peerJid: '11343495192601@lid',
    })

    expect(session.contacts.getByJid).toHaveBeenCalledWith('11343495192601@lid')
    expect(client.voip.rejectCall).toHaveBeenCalledWith('call-lid')
    expect(client.message.send).toHaveBeenCalledWith('5566996269251@s.whatsapp.net', {
      type: 'text', text: 'Não atendemos chamadas por aqui.',
    })
  })

  test('publishes the contact name and confirmed number with an incoming bridged call', async () => {
    session.contacts.getByJid.mockResolvedValue({
      jid: '11343495192601@lid',
      lid: '11343495192601@lid',
      phoneNumber: '556699554300',
      displayName: 'Joao da Silva',
      pushName: 'Joao',
    } as never)
    session.contacts.getByPhoneNumber.mockResolvedValue(null)
    await service.connect(1)
    const voiceBridge = { publishIncoming: jest.fn().mockReturnValue(true) }
    ;(service as any).voiceBridge = voiceBridge

    const call = {
      callId: 'call-with-name',
      peerJid: '11343495192601@lid',
      direction: 'incoming',
      mediaType: 'audio',
      canAccept: true,
    }
    await handlers.voip_call_incoming(call)

    expect(voiceBridge.publishIncoming).toHaveBeenCalledWith(call, {
      callerPn: '5566999554300',
      callerName: 'Joao da Silva',
      callerNameSource: 'display_name',
    })
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

  test('decrypts every carousel image and replaces the encrypted CDN URL with the S3 URL', async () => {
    client.message.downloadBytes.mockResolvedValue(Uint8Array.from([10, 20, 30]))
    await service.connect(1)
    const message: any = {
      key: { id: 'carousel-zapo-1', remoteJid: '111@lid', fromMe: false },
      message: {
        interactiveMessage: {
          carouselMessage: {
            cards: [{
              header: {
                imageMessage: {
                  url: 'https://mmg.whatsapp.net/card.enc',
                  directPath: '/card.enc',
                  mediaKey: { 1: 2, 0: 1 },
                  mimetype: 'image/jpeg',
                },
              },
            }],
          },
        },
      },
    }

    const normalized: any = await service.getMessageMetadata(message)

    expect(client.message.downloadBytes).toHaveBeenCalledWith({
      imageMessage: expect.objectContaining({
        directPath: '/card.enc',
        mediaKey: Uint8Array.from([1, 2]),
      }),
    })
    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith(
      `${phone}/carousel-zapo-1-carousel-0.jpeg`,
      Buffer.from([10, 20, 30]),
      'image/jpeg',
    )
    expect(normalized.message.interactiveMessage.carouselMessage.cards[0].header.imageMessage.url)
      .toBe(`https://s3.example.test/${phone}/carousel-zapo-1-carousel-0.jpeg`)
  })

  test('restores replayed media bytes before using the official Zapo downloader', async () => {
    client.message.downloadBytes.mockResolvedValue(Uint8Array.from([4, 5, 6]))
    await service.connect(1)

    const normalized: any = await service.getMessageMetadata({
      key: { id: 'media-echo-1', remoteJid: '111@lid', fromMe: true },
      messageTimestamp: 123,
      pushName: 'Eu',
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          directPath: '/media-echo',
          url: 'https://mmg.whatsapp.net/encrypted',
          mediaKey: { 1: 2, 0: 1 },
        },
      },
    })

    expect(client.message.downloadBytes).toHaveBeenCalledWith(expect.objectContaining({
      imageMessage: expect.objectContaining({
        directPath: '/media-echo',
        mediaKey: Uint8Array.from([1, 2]),
      }),
    }))
    expect(normalized.__unoapiMediaBytes).toEqual(Buffer.from([4, 5, 6]))
  })

  test('downloads a replayed PDF wrapped in documentWithCaptionMessage', async () => {
    client.message.downloadBytes.mockResolvedValue(Uint8Array.from([7, 8, 9]))
    await service.connect(1)

    const normalized: any = await service.getMessageMetadata({
      key: { id: 'pdf-1', remoteJid: '111@lid', fromMe: false },
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: 'application/pdf',
              fileName: 'ofertas.pdf',
              directPath: '/document',
              mediaKey: { 1: 2, 0: 1 },
            },
          },
        },
      },
    })

    expect(client.message.downloadBytes).toHaveBeenCalledWith(expect.objectContaining({
      documentMessage: expect.objectContaining({
        fileName: 'ofertas.pdf',
        mediaKey: Uint8Array.from([1, 2]),
      }),
    }))
    expect(normalized.__unoapiMediaBytes).toEqual(Buffer.from([7, 8, 9]))
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
