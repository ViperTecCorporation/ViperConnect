jest.mock('../../src/utils/audio_convert', () => ({
  __esModule: true,
  convertToOggPtt: jest.fn(async () => ({ buffer: Buffer.from('OGG'), mimetype: 'audio/ogg; codecs=opus' }))
}))
jest.mock('../../src/defaults', () => {
  const actual = jest.requireActual('../../src/defaults')
  return {
    __esModule: true,
    ...actual,
    SEND_AUDIO_MESSAGE_AS_PTT: true,
    GROUP_METADATA_EVENT_REFRESH_DEBOUNCE_MS: 10,
    GROUP_METADATA_EVENT_REFRESH_MIN_INTERVAL_MS: 0,
  }
})
jest.mock('../../src/services/socket')
jest.mock('../../src/services/client_voip', () => ({
  __esModule: true,
  mapBaileysCallStatusToVoipEvent: jest.fn((status: string) => status === 'ringing' ? 'incoming_call' : undefined),
  sendVoipCallEvent: jest.fn(async () => ({ ok: true, status: 200 })),
  sendVoipSignaling: jest.fn(async () => ({ ok: true, status: 200 })),
  drainVoipCommands: jest.fn(async () => ({ ok: true, status: 200, body: { commands: [] } })),
  extractVoipCommands: jest.fn((body: any) => body?.commands || []),
}))
jest.mock('../../src/services/redis', () => ({
  __esModule: true,
  setContactSyncPending: jest.fn(async () => undefined),
  getPnForLidFromAuthCache: jest.fn(async () => undefined),
  getLidForPnFromAuthCache: jest.fn(async () => undefined),
}))
import { ClientBaileys, normalizeOutgoingVoipCallChild } from '../../src/services/client_baileys'
import { Client } from '../../src/services/client'
import { Config, getConfig, defaultConfig } from '../../src/services/config'
import { Response } from '../../src/services/response'
import { Listener } from '../../src/services/listener'
import { Store } from '../../src/services/store'
import {
  connect,
  Status,
  sendMessage,
  readMessages,
  rejectCall,
  sendCallNode,
  fetchImageUrl,
  fetchGroupMetadata,
  groupMetadata,
  exists,
  close,
  logout,
} from '../../src/services/socket'
import { mock, mockFn } from 'jest-mock-extended'
import { encodeBinaryNode, proto } from '@whiskeysockets/baileys'
import { DataStore } from '../../src/services/data_store'
import { Incoming } from '../../src/services/incoming'
import { dataStores } from '../../src/services/data_store'
import logger from '../../src/services/logger'
import { SessionStore } from '../../src/services/session_store'
import { SendError } from '../../src/services/send_error'
import { drainVoipCommands, sendVoipCallEvent, sendVoipSignaling, extractVoipCommands } from '../../src/services/client_voip'
import { getLidForPnFromAuthCache } from '../../src/services/redis'

const mockConnect = connect as jest.MockedFunction<typeof connect>

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const event = (event, _callback) => {
  logger.info('subscribe event: %s', event)
}

const onNewLogin = async (phone: string) => {
  logger.info('New login %s', phone)
}

describe('service client baileys', () => {
  let client: Client
  let phone: string
  let listener: Listener
  let incoming: Incoming
  let store: Store
  let dataStore: DataStore
  let sessionStore: SessionStore
  let send
  let read
  let logout
  let exists
  let rejectCall
  let sendCallNodeMock
  let fetchImageUrl
  let fetchGroupMetadata
  let groupMetadataMock
  let getConfig: getConfig
  let config: Config
  let close: close
  let eventHandlers: Record<string, Function>

  const status: Status = { attempt: 0 }

  beforeEach(async () => {
    mockConnect.mockReset()
    ;(sendVoipCallEvent as jest.Mock).mockReset()
    ;(sendVoipCallEvent as jest.Mock).mockResolvedValue({ ok: true, status: 200 })
    ;(sendVoipSignaling as jest.Mock).mockReset()
    ;(sendVoipSignaling as jest.Mock).mockResolvedValue({ ok: true, status: 200 })
    ;(drainVoipCommands as jest.Mock).mockReset()
    ;(drainVoipCommands as jest.Mock).mockResolvedValue({ ok: true, status: 200, body: { commands: [] } })
    ;(extractVoipCommands as jest.Mock).mockReset()
    ;(extractVoipCommands as jest.Mock).mockImplementation(() => [])
    ;(getLidForPnFromAuthCache as jest.Mock).mockReset()
    ;(getLidForPnFromAuthCache as jest.Mock).mockResolvedValue(undefined)
    phone = `${new Date().getMilliseconds()}`
    listener = mock<Listener>()
    incoming = mock<Incoming>()
    dataStore = mock<DataStore>()
    dataStore.loadUnoId.mockImplementation(async (id: string) => `uno-${id}`)
    sessionStore = mock<SessionStore>()
    close = mockFn<close>()
    store = mock<Store>()
    store.dataStore = dataStore
    store.sessionStore = sessionStore
    ;(store as any).state = {
      creds: {
        me: {
          id: '556699554300:52@s.whatsapp.net',
          lid: '11343495192601:52@lid',
        },
      },
    }
    config = defaultConfig
    config.ignoreGroupMessages = true
    eventHandlers = {}
    getConfig = async (_phone: string) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      config.getStore = async (_phone: string) => {
        return store
      }
      return config
    }
    client = new ClientBaileys(phone, listener, getConfig, onNewLogin)
    send = mockFn<sendMessage>()
    read = mockFn<readMessages>().mockResolvedValue(true)
    exists = mockFn<exists>()
    rejectCall = mockFn<rejectCall>()
    sendCallNodeMock = mockFn<sendCallNode>().mockResolvedValue(undefined)
    logout = mockFn<logout>()
    fetchImageUrl = mockFn<fetchImageUrl>()
    fetchGroupMetadata = mockFn<fetchGroupMetadata>()
    groupMetadataMock = mockFn<groupMetadata>()
    const capturedEvent = (name, callback) => {
      eventHandlers[name] = callback
      return event(name, callback)
    }
    mockConnect.mockResolvedValue({ event: capturedEvent as any, status, send, read, rejectCall, sendCallNode: sendCallNodeMock, fetchImageUrl, fetchGroupMetadata, groupMetadata: groupMetadataMock, exists, close, logout })
  })

  test('call send with unknown status', async () => {
    const status = `${new Date().getMilliseconds()}`
    try {
      await client.send({ status }, {})
      expect(true).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      expect(e.message).toBe(`Unknow message status ${status}`)
    }
  })

  test('call send with read status', async () => {
    const loadKey = jest.spyOn(store?.dataStore, 'loadKey')
    loadKey.mockReturnValue(new Promise((resolve) => resolve({ id: `${new Date().getMilliseconds()}` })))
    await client.connect(0)
    const response: Response = await client.send({ status: 'read', to: `${new Date().getMilliseconds()}` }, {})
    expect(loadKey).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(response.ok).toStrictEqual({ success: true })
  })

  test('call send with message text success', async () => {
    const anyMessage: Promise<proto.WebMessageInfo> = mock<Promise<proto.WebMessageInfo>>()
    send.mockReturnValue(anyMessage)
    const to = '5566996923653'
    const id = `${new Date().getMilliseconds()}`
    send.mockResolvedValue({ key: { id } })
    const payload = { to, type: 'text', text: { body: `${new Date().getMilliseconds()}` } }
    await client.connect(0)
    const response: Response = await client.send(payload, {})
    expect(send).toHaveBeenCalledTimes(1)
    expect(response.ok.messages[0].id).toBe(`uno-${id}`)
  })

  test('recovers delivery by refreshing sessions and resending with mapped provider id', async () => {
    const unoId = 'uno-message-1'
    const providerId = 'provider-message-1'
    dataStore.loadProviderId.mockResolvedValue(providerId)
    dataStore.loadUnoId.mockImplementation(async (id: string) => id === providerId ? unoId : undefined)
    send.mockResolvedValue({
      key: { id: providerId, remoteJid: '5566996810064@s.whatsapp.net' },
      message: { conversation: 'reenviar agora' },
    })

    await client.connect(0)
    const response = await client.recoverDelivery!({
      message_id: unoId,
      to: '5566996810064',
      type: 'text',
      text: { body: 'reenviar agora' },
    }, {})

    expect(send).toHaveBeenCalledWith(
      '5566996810064@s.whatsapp.net',
      expect.objectContaining({ text: 'reenviar agora' }),
      expect.objectContaining({
        messageId: providerId,
        forceDeliveryRecovery: true,
        forceSessionRefresh: true,
        forceDeviceList: true,
        useUserDevicesCache: false,
      }),
    )
    expect(dataStore.setUnoId).toHaveBeenCalledWith(providerId, unoId)
    expect(response.ok.messages[0].id).toBe(unoId)
    expect((response.ok as any).recovery).toEqual(expect.objectContaining({
      attempted: true,
      message_id: unoId,
      provider_id: providerId,
    }))
  })

  test('call send with recipient_type group normalizes destination and response ids', async () => {
    const id = `${new Date().getMilliseconds()}`
    send.mockResolvedValue({ key: { id, remoteJid: '120363040468224422@g.us' } })
    const payload = {
      recipient_type: 'group',
      to: '120363040468224422',
      type: 'text',
      text: { body: 'Ola pessoal' },
    }
    await client.connect(0)
    const response: Response = await client.send(payload, {})

    expect(send).toHaveBeenCalledWith(
      '120363040468224422@g.us',
      expect.objectContaining({ text: 'Ola pessoal' }),
      expect.any(Object),
    )
    expect(response.ok.contacts[0]).toEqual({
      input: '120363040468224422@g.us',
      wa_id: '120363040468224422@g.us',
    })
    expect(response.ok.messages[0].id).toBe(`uno-${id}`)
  })

  test('normalizes contact vcard phone with baileys auth cache before sending', async () => {
    const id = `${new Date().getMilliseconds()}`
    send.mockResolvedValue({ key: { id, remoteJid: '5566991111111@s.whatsapp.net' } })
    ;(getLidForPnFromAuthCache as jest.Mock).mockImplementation(async (_session: string, pnJid: string) => (
      pnJid === '5549988887777@s.whatsapp.net' ? '111222333@lid' : undefined
    ))
    const payload = {
      to: '5566991111111',
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: 'Contato teste' },
          phones: [{ phone: '+554988887777', wa_id: '554988887777' }],
        },
      ],
    }

    await client.connect(0)
    await client.send(payload, {})

    const sentContent = send.mock.calls[0][1]
    const vcard = sentContent.contacts.contacts[0].vcard
    expect(getLidForPnFromAuthCache).toHaveBeenCalledWith(phone, '554988887777@s.whatsapp.net')
    expect(getLidForPnFromAuthCache).toHaveBeenCalledWith(phone, '5549988887777@s.whatsapp.net')
    expect(vcard).toContain('WAID=5549988887777')
    expect(vcard).toContain(':+5549988887777')
  })

  test('call send with message_edit resolves original Uno id to Baileys edit key', async () => {
    const unoMessageId = 'uno-original-message'
    const providerMessageId = 'provider-original-message'
    const editMessageId = 'provider-edit-message'
    const originalKey = {
      id: providerMessageId,
      remoteJid: '120363040468224422@g.us',
      fromMe: true,
      participant: '556600000000@s.whatsapp.net',
      participantPn: '556600000000@s.whatsapp.net',
      participantLid: '999999999999@lid',
    }
    dataStore.loadProviderId.mockImplementation(async (id: string) => (
      id === unoMessageId ? providerMessageId : undefined
    ))
    dataStore.loadKey.mockImplementation(async (id: string) => (
      id === providerMessageId ? originalKey : undefined
    ))
    dataStore.loadMessage.mockResolvedValue({ key: originalKey })
    send.mockResolvedValue({
      key: { id: editMessageId, remoteJid: originalKey.remoteJid },
      message: { protocolMessage: { type: 'MESSAGE_EDIT' } },
    })
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'group',
      to: '120363040468224422@g.us',
      type: 'message_edit',
      context: { message_id: unoMessageId },
      text: { body: 'texto editado' },
    }

    await client.connect(0)
    const response: Response = await client.send(payload, {})

    expect(send).toHaveBeenCalledWith(
      originalKey.remoteJid,
      expect.objectContaining({
        text: 'texto editado',
        edit: { id: providerMessageId, remoteJid: originalKey.remoteJid, fromMe: true },
      }),
      expect.objectContaining({
        forceRemoteJid: originalKey.remoteJid,
        skipBrSendOrder: true,
      }),
    )
    expect(dataStore.loadProviderId).toHaveBeenCalledWith(unoMessageId)
    expect(dataStore.loadKey).toHaveBeenCalledWith(providerMessageId)
    expect(response.ok.messages[0].id).toBe(`uno-${editMessageId}`)
  })

  test('call send with message_edit removes participant from own individual edit key', async () => {
    const unoMessageId = 'uno-original-individual-message'
    const providerMessageId = 'provider-original-individual-message'
    const editMessageId = 'provider-edit-individual-message'
    const originalKey = {
      id: providerMessageId,
      remoteJid: '556696890270@s.whatsapp.net',
      fromMe: true,
      participant: '556600000000@s.whatsapp.net',
    }
    dataStore.loadProviderId.mockImplementation(async (id: string) => (
      id === unoMessageId ? providerMessageId : undefined
    ))
    dataStore.loadKey.mockImplementation(async (id: string) => (
      id === providerMessageId ? originalKey : undefined
    ))
    dataStore.loadMessage.mockResolvedValue({ key: originalKey })
    send.mockResolvedValue({
      key: { id: editMessageId, remoteJid: originalKey.remoteJid },
      message: { protocolMessage: { type: 'MESSAGE_EDIT' } },
    })

    await client.connect(0)
    await client.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5566996890270',
      type: 'message_edit',
      context: { message_id: unoMessageId },
      text: { body: 'texto editado' },
    }, {})

    expect(send).toHaveBeenCalledWith(
      originalKey.remoteJid,
      expect.objectContaining({
        text: 'texto editado',
        edit: { id: providerMessageId, remoteJid: originalKey.remoteJid, fromMe: true },
      }),
      expect.any(Object),
    )
  })

  test('refreshes group metadata cache after group participants update event', async () => {
    const groupJid = '120363040468224422@g.us'
    const metadata = {
      id: groupJid,
      subject: 'Grupo atualizado',
      participants: [
        { id: '5566996222471@s.whatsapp.net' },
        { id: '11343495192601@lid' },
      ],
    }
    groupMetadataMock.mockResolvedValue(metadata)

    await client.connect(0)
    await eventHandlers['group-participants.update']?.({
      id: groupJid,
      participants: ['5566996222471@s.whatsapp.net'],
      action: 'add',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(groupMetadataMock).toHaveBeenCalledWith(groupJid)
    expect(dataStore.setGroupMetada).toHaveBeenCalledWith(groupJid, metadata)
  })

  test('refreshes group metadata cache after groups update event', async () => {
    const groupJid = '120363040468224422@g.us'
    const metadata = { id: groupJid, subject: 'Novo nome', participants: [] }
    groupMetadataMock.mockResolvedValue(metadata)

    await client.connect(0)
    await eventHandlers['groups.update']?.([{ id: groupJid, subject: 'Novo nome' }])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(groupMetadataMock).toHaveBeenCalledWith(groupJid)
    expect(dataStore.setGroupMetada).toHaveBeenCalledWith(groupJid, metadata)
  })

  test('persists refreshed group profile picture in group metadata cache', async () => {
    const groupJid = '120363040468224422@g.us'
    const metadata = { id: groupJid, subject: 'Grupo com foto', participants: [] }
    const picture = 'https://cdn.example.com/group.jpg'
    sessionStore.isStatusOnline.mockResolvedValue(true)
    fetchGroupMetadata.mockResolvedValue(metadata)
    fetchImageUrl.mockResolvedValue(picture)

    ;(client as any).store = store
    ;(client as any).config = { ...defaultConfig, sendProfilePicture: true }
    ;(client as any).fetchGroupMetadata = fetchGroupMetadata
    ;(client as any).fetchImageUrl = fetchImageUrl
    ;(client as any).exists = exists
    const message = await (client as any).getMessageMetadata({
      key: {
        remoteJid: groupJid,
        participant: '5566996222471@s.whatsapp.net',
      },
      message: { conversation: 'teste' },
    })

    expect(message.groupMetadata.profilePicture).toBe(picture)
    expect(dataStore.setGroupMetada).toHaveBeenCalledWith(groupJid, expect.objectContaining({
      id: groupJid,
      subject: 'Grupo com foto',
      profilePicture: picture,
    }))
  })

  test('normalizes device-qualified LID ids before exposing message metadata', async () => {
    const lid = '190280070385782@lid'
    sessionStore.isStatusOnline.mockResolvedValue(true)

    ;(client as any).store = store
    ;(client as any).config = { ...defaultConfig, sendProfilePicture: false }
    ;(client as any).fetchGroupMetadata = fetchGroupMetadata
    ;(client as any).fetchImageUrl = fetchImageUrl
    ;(client as any).exists = exists

    const message = await (client as any).getMessageMetadata({
      key: {
        remoteJid: '190280070385782:35@lid',
      },
      message: { conversation: 'teste' },
    })

    expect(message.key.remoteJid).toBe(lid)
    expect(message.key.senderLid).toBe(lid)
    expect(dataStore.getPnForLid).toHaveBeenCalledWith(phone, lid)
  })

  test('call send with message type unknown', async () => {
    const type = `${new Date().getMilliseconds()}`
    try {
      await client.connect(0)
      await client.send({ type }, {})
      expect(true).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      expect(e.message).toBe(`Unknow message type ${type}`)
    }
  })

  test('call send with error', async () => {
    const payload = { to: `${new Date().getMilliseconds()}`, type: 'text', text: { body: `${new Date().getMilliseconds()}` } }
    send = async () => {
      throw new SendError(1, '')
    }
    mockConnect.mockResolvedValue({ event, status, send, read, rejectCall, sendCallNode: sendCallNodeMock, fetchImageUrl, fetchGroupMetadata, groupMetadata: groupMetadataMock, exists, close, logout })
    await client.connect(0)
    const response = await client.send(payload, {})
    expect(response.error.entry.length).toBe(1)
  })

  test('retry stale send once after reconnect without duplicating first attempt', async () => {
    const to = `${new Date().getMilliseconds()}`
    const payload = { to, type: 'text', text: { body: 'retry after reconnect' } }
    const firstSend = mockFn<sendMessage>().mockRejectedValue({
      message: 'Send failed due to stale connection; safe to retry after reconnect',
      data: {
        retryAfterReconnect: true,
        retriable: true,
        retryableSend: {
          targetJid: `${to}@s.whatsapp.net`,
          fullMessage: {
            message: {
              conversation: 'retry after reconnect',
            },
          },
          relayOptions: {
            messageId: 'retryable-msg-id',
          },
        },
      },
    })
    const secondSend = mockFn<sendMessage>().mockResolvedValue({
      key: { id: 'resent-id', remoteJid: `${to}@s.whatsapp.net` },
      message: { conversation: 'retry after reconnect' },
    } as any)
    const firstClose = mockFn<close>()
    const secondClose = mockFn<close>()
    mockConnect
      .mockResolvedValueOnce({ event, status, send: firstSend, read, rejectCall, sendCallNode: sendCallNodeMock, fetchImageUrl, fetchGroupMetadata, exists, close: firstClose, logout })
      .mockResolvedValueOnce({ event, status, send: secondSend, read, rejectCall, sendCallNode: sendCallNodeMock, fetchImageUrl, fetchGroupMetadata, exists, close: secondClose, logout })

    await client.connect(0)
    const response: Response = await client.send(payload, {})

    expect(firstSend).toHaveBeenCalledTimes(1)
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(secondSend).toHaveBeenCalledTimes(1)
    expect(secondSend).toHaveBeenCalledWith(
      `${to}@s.whatsapp.net`,
      { conversation: 'retry after reconnect' },
      expect.objectContaining({
        messageId: 'retryable-msg-id',
        __staleReconnectRetried: true,
      }),
    )
    expect(response.ok.messages[0].id).toBe('uno-resent-id')
  })

  test('call disconnect', async () => {
    await client.disconnect()
    expect(dataStores.size).toBe(0)
  })

  test('call send with audio mp3 converts to ogg ptt', async () => {
    const anyMessage: Promise<proto.WebMessageInfo> = mock<Promise<proto.WebMessageInfo>>()
    const id = `${new Date().getMilliseconds()}`
    // Intercept send to assert transformed content
    ;(send as jest.MockedFunction<any>).mockImplementation(async (_to, message, _opts) => {
      expect(Buffer.isBuffer(message.audio)).toBe(true)
      expect(message.ptt).toBe(true)
      expect(message.mimetype).toBe('audio/ogg; codecs=opus')
      return { key: { id } }
    })
    const to = `${new Date().getMilliseconds()}`
    const payload = { to, type: 'audio', audio: { link: `http://example.com/test.mp3` } }
    await client.connect(0)
    const response: Response = await client.send(payload, {})
    expect(send).toHaveBeenCalledTimes(1)
    expect(response.ok.messages[0].id).toBe(`uno-${id}`)
  })

  test('call ringing rejects using callerPn when available', async () => {
    config.rejectCalls = 'Nao posso atender agora'
    await client.connect(0)

    await eventHandlers.call?.([
      {
        from: '123456789012345@lid',
        callerPn: '556696923653@s.whatsapp.net',
        id: 'call-1',
        status: 'ringing',
      },
    ])

    expect(rejectCall).toHaveBeenCalledWith('call-1', '123456789012345@lid')
    expect(send).toHaveBeenCalledWith('556696923653@s.whatsapp.net', { text: config.rejectCalls }, {})
  })

  test('call offer rejects as incoming call when Baileys sends LID identity', async () => {
    config.rejectCalls = 'Nao posso atender agora'
    await client.connect(0)

    await eventHandlers.call?.([
      {
        from: '123456789012345@lid',
        callerPn: '556696923653@s.whatsapp.net',
        id: 'call-offer-1',
        status: 'offer',
      },
    ])

    expect(rejectCall).toHaveBeenCalledWith('call-offer-1', '123456789012345@lid')
    expect(send).toHaveBeenCalledWith('556696923653@s.whatsapp.net', { text: config.rejectCalls }, {})
  })

  test('call ringing falls back to from when callerPn is absent', async () => {
    config.rejectCalls = 'Nao posso atender agora'
    await client.connect(0)

    await eventHandlers.call?.([
      {
        from: '5566996923653@s.whatsapp.net',
        id: 'call-2',
        status: 'ringing',
      },
    ])

    expect(rejectCall).toHaveBeenCalledWith('call-2', '5566996923653@s.whatsapp.net')
  })

  test('call event notifies voip service when status maps', async () => {
    await client.connect(0)

    await eventHandlers.call?.([
      {
        from: '123456789012345@lid',
        callerPn: '556696923653@s.whatsapp.net',
        id: 'call-3',
        status: 'ringing',
        isVideo: true,
        timestamp: 1774650364,
      },
    ])

    expect(sendVoipCallEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session: phone,
        event: 'incoming_call',
        callId: 'call-3',
        from: '123456789012345@lid',
        callerPn: '556696923653@s.whatsapp.net',
        selfJid: '556699554300:52@s.whatsapp.net',
        selfLid: '11343495192601:52@lid',
        isVideo: true,
        timestamp: 1774650364,
      }),
    )
  })

  test('call event processes send_call_node commands from voip service', async () => {
    ;(sendVoipCallEvent as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        commands: [
          {
            action: 'send_call_node',
            session: phone,
            callId: 'call-4',
            peerJid: '123456789012345@lid',
            payloadTag: 'call',
            payloadBase64: Buffer.from('<offer call-id="call-4" call-creator="123456789012345@lid"/>').toString('base64'),
          },
        ],
      },
    })
    ;(extractVoipCommands as jest.Mock).mockImplementation((body: any) => body.commands)

    await client.connect(0)
    await eventHandlers.call?.([
      {
        from: '123456789012345@lid',
        id: 'call-4',
        status: 'ringing',
      },
    ])

    expect(sendCallNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'call',
        attrs: expect.objectContaining({ to: '123456789012345@lid' }),
      }),
    )
  })

  test('call event sends exact call stanza generated by voip service when payload already has call root', async () => {
    ;(sendVoipCallEvent as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        commands: [
          {
            action: 'send_call_node',
            session: phone,
            callId: 'call-6',
            peerJid: 'ignored@lid',
            payloadTag: 'call',
            payloadBase64: Buffer.from('<call from="self@s.whatsapp.net" to="999@lid"><offer call-id="call-6" call-creator="999@lid"/></call>').toString('base64'),
          },
        ],
      },
    })
    ;(extractVoipCommands as jest.Mock).mockImplementation((body: any) => body.commands)

    await client.connect(0)
    await eventHandlers.call?.([
      {
        from: '123456789012345@lid',
        id: 'call-6',
        status: 'ringing',
      },
    ])

    expect(sendCallNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'call',
        attrs: expect.objectContaining({
          from: 'self@s.whatsapp.net',
          to: '999@lid',
        }),
      }),
    )
  })

  test('call event processes call stanza commands from voip service', async () => {
    ;(sendVoipCallEvent as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        commands: [
          {
            action: 'send_call_node',
            session: phone,
            callId: 'call-7',
            peerJid: 'ignored@lid',
            payloadTag: 'call',
            payloadBase64: Buffer.from('<call from="self@s.whatsapp.net" to="123456789012345@s.whatsapp.net"><accept call-id="call-7" call-creator="123456789012345@s.whatsapp.net"/></call>').toString('base64'),
          },
        ],
      },
    })
    ;(extractVoipCommands as jest.Mock).mockImplementation((body: any) => body.commands)

    await client.connect(0)
    await eventHandlers.call?.([
      {
        from: '123456789012345@lid',
        id: 'call-7',
        status: 'ringing',
      },
    ])
    expect(sendCallNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'call',
        attrs: expect.objectContaining({
          from: 'self@s.whatsapp.net',
          to: '123456789012345@s.whatsapp.net',
        }),
        content: expect.objectContaining({
          tag: 'accept',
          attrs: expect.objectContaining({ 'call-id': 'call-7' }),
        }),
      }),
    )
  })

  test('drained async voip commands are sent back to WhatsApp', async () => {
    ;(drainVoipCommands as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        commands: [
          {
            action: 'send_call_node',
            session: phone,
            callId: 'call-9',
            peerJid: '123456789012345@s.whatsapp.net',
            payloadTag: 'call',
            payloadBase64: Buffer.from('<accept call-id="call-9" call-creator="123456789012345@s.whatsapp.net"/>').toString('base64'),
          },
        ],
      },
    })
    ;(extractVoipCommands as jest.Mock).mockImplementation((body: any) => body.commands || [])

    await client.connect(0)
    const commandCount = await (client as any).drainAndProcessVoipCommands('call-9', 1, 'test')

    expect(commandCount).toBe(1)
    expect(drainVoipCommands).toHaveBeenCalledWith(expect.anything(), phone, 'call-9')
    expect(sendCallNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'call',
        attrs: expect.objectContaining({
          to: '123456789012345@s.whatsapp.net',
        }),
        content: expect.arrayContaining([
          expect.objectContaining({
            tag: 'accept',
            attrs: expect.objectContaining({ 'call-id': 'call-9' }),
          }),
        ]),
      }),
    )
  })

  test('forwards WhatsApp call node ack back to voip service', async () => {
    const acceptNode = {
      tag: 'accept',
      attrs: {
        'call-id': 'call-ack',
        'call-creator': '123456789012345@s.whatsapp.net',
      },
    }
    const ackNode = {
      tag: 'ack',
      attrs: {
        id: 'ack-1',
        type: 'accept',
      },
    }
    sendCallNodeMock.mockResolvedValue(ackNode)
    ;(extractVoipCommands as jest.Mock).mockImplementation((body: any) => body?.commands || [])

    await client.connect(0)
    await (client as any).processVoipCommands([
      {
        action: 'send_call_node',
        session: phone,
        callId: 'call-ack',
        peerJid: '123456789012345@s.whatsapp.net',
        payloadTag: 'call',
        payloadBase64: Buffer.from(
          '<accept call-id="call-ack" call-creator="123456789012345@s.whatsapp.net"/>'
        ).toString('base64'),
      },
    ])

    expect(sendCallNodeMock).toHaveBeenCalled()
    expect(sendVoipSignaling).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session: phone,
        callId: 'call-ack',
        peerJid: '123456789012345@s.whatsapp.net',
        msgType: 'ack',
        payloadBase64: Buffer.from(encodeBinaryNode(ackNode)).toString('base64'),
        payloadEncoding: 'wa_binary',
        attrs: {
          error: '0',
          type: 'accept',
        },
      }),
    )
  })

  test('restores lid identity in outgoing voip call command attrs', () => {
    expect(normalizeOutgoingVoipCallChild({
      tag: 'accept',
      attrs: {
        'call-id': 'call-lid-route',
        'call-creator': '94047083475061@s.whatsapp.net',
        peer: '94047083475061@s.whatsapp.net',
      },
    }, '94047083475061@lid')).toEqual({
      tag: 'accept',
      attrs: {
        'call-id': 'call-lid-route',
        'call-creator': '94047083475061@lid',
        peer: '94047083475061@lid',
      },
    })
  })

  test('raw call node forwards signaling to voip service', async () => {
    await client.connect(0)

    await eventHandlers['call.raw']?.({
      tag: 'call',
      attrs: {
        from: '120363000000@g.us',
        t: '1774650364',
      },
      content: [
        {
          tag: 'offer',
          attrs: {
            'call-id': 'call-5',
            from: '123456789012345@lid',
            'call-creator': '123456789012345@lid',
            caller_pn: '559999999999@s.whatsapp.net',
          },
          content: [
            {
              tag: 'enc',
              attrs: {},
              content: Buffer.from('test-enc-payload'),
            },
          ],
        },
      ],
    })

    expect(sendVoipSignaling).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        session: phone,
        callId: 'call-5',
        peerJid: '123456789012345@s.whatsapp.net',
        selfJid: '556699554300:52@s.whatsapp.net',
        selfLid: '11343495192601:52@lid',
        msgType: 'offer',
        payloadBase64: expect.any(String),
        payloadEncoding: 'wa_binary',
      }),
    )
  })

  test('call signaling keeps original lid peer for voip service and replies', async () => {
    const acceptNode = {
      tag: 'accept',
      attrs: {
        'call-id': 'call-8',
        'call-creator': '123456789012345@s.whatsapp.net',
      },
    }
    ;(sendVoipSignaling as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        commands: [
          {
            action: 'send_call_node',
            session: phone,
            callId: 'call-8',
            peerJid: '123456789012345@s.whatsapp.net',
            payloadTag: 'call',
            payloadBase64: Buffer.from(
              '<accept call-id="call-8" call-creator="123456789012345@s.whatsapp.net"/>'
            ).toString('base64'),
          },
        ],
      },
    })
    ;(extractVoipCommands as jest.Mock).mockImplementation((body: any) => body.commands || [])

    await client.connect(0)

    await eventHandlers['call.raw']?.({
      tag: 'call',
      attrs: {
        from: '123456789012345@lid',
        t: '1774650364',
      },
      content: [
        {
          tag: 'offer',
          attrs: {
            'call-id': 'call-8',
            'call-creator': '123456789012345@lid',
            caller_pn: '559999999999@s.whatsapp.net',
          },
          content: [
            {
              tag: 'enc',
              attrs: {},
              content: Buffer.from('test-enc-payload'),
            },
          ],
        },
      ],
    })

    expect(sendVoipSignaling).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callId: 'call-8',
        peerJid: '123456789012345@lid',
        selfJid: '556699554300:52@s.whatsapp.net',
        selfLid: '11343495192601:52@lid',
      }),
    )
    expect(sendCallNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'call',
        attrs: expect.objectContaining({
          to: '123456789012345@lid',
        }),
        content: expect.arrayContaining([
          expect.objectContaining({
            tag: 'accept',
            attrs: expect.objectContaining({
              'call-id': 'call-8',
              'call-creator': '123456789012345@lid',
            }),
          }),
        ]),
      }),
    )
  })

  test('raw offer starts async command drain polling', async () => {
    await client.connect(0)

    await eventHandlers['call.raw']?.({
      tag: 'call',
      attrs: {
        from: '123456789012345@lid',
        t: '1774650364',
      },
      content: [
        {
          tag: 'offer',
          attrs: {
            'call-id': 'call-10',
            'call-creator': '123456789012345@lid',
            caller_pn: '559999999999@s.whatsapp.net',
          },
          content: [
            {
              tag: 'enc',
              attrs: {},
              content: Buffer.from('test-enc-payload'),
            },
          ],
        },
      ],
    })

    expect((client as any).voipCommandDrainPollers.has(`${phone}:call-10`)).toBe(true)
    ;(client as any).voipCommandDrainPollers.delete(`${phone}:call-10`)
  })
})
