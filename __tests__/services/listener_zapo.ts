import { mock } from 'jest-mock-extended'
import type { Broadcast } from '../../src/services/broadcast'
import { defaultConfig, type Config } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import { ListenerZapo } from '../../src/services/listener_zapo'
import type { MediaStore } from '../../src/services/media_store'
import type { Outgoing } from '../../src/services/outgoing'
import type { Store } from '../../src/services/store'
import type { ZapoMessageMetadataResolver } from '../../src/services/zapo/zapo_message_metadata'
import { MessageFilter } from '../../src/services/message_filter'
import { getPollState, setPollState } from '../../src/services/redis'

jest.mock('../../src/services/redis', () => ({
  ...jest.requireActual('../../src/services/redis'),
  getPollState: jest.fn(),
  setPollState: jest.fn(),
}))

describe('ListenerZapo', () => {
  let config: Config
  let store: Store
  let outgoing: Outgoing
  let service: ListenerZapo
  let messageMetadata: ZapoMessageMetadataResolver
  let pollStates: Map<string, any>

  beforeEach(() => {
    store = mock<Store>()
    store.dataStore = mock<DataStore>()
    store.mediaStore = mock<MediaStore>()
    ;(store.dataStore.setUnoId as jest.Mock).mockImplementation(async (_providerId: string, unoId: string) => unoId)
    outgoing = mock<Outgoing>()
    config = { ...defaultConfig, provider: 'zapo', getStore: jest.fn().mockResolvedValue(store) }
    messageMetadata = {
      resolve: jest.fn(async (_phone: string, message: any) => message),
    }
    pollStates = new Map()
    ;(getPollState as jest.Mock).mockImplementation(async (phone: string, jid: string, id: string) => pollStates.get(`${phone}|${jid}|${id}`))
    ;(setPollState as jest.Mock).mockImplementation(async (phone: string, jid: string, id: string, state: any) => {
      pollStates.set(`${phone}|${jid}|${id}`, state)
    })
    service = new ListenerZapo(outgoing, mock<Broadcast>(), async () => config, messageMetadata)
  })

  test('maps the official Zapo id to an external Uno id and forwards the webhook', async () => {
    await service.process('5566999999999', [{
      key: {
        id: '3EB0ZAPO',
        remoteJid: '123@lid',
        remoteJidAlt: '5566998888888@s.whatsapp.net',
        senderUsername: 'maria',
        fromMe: false,
      },
      message: { conversation: 'oi' },
      messageTimestamp: 1,
      pushName: 'Maria',
    }], 'notify')

    expect(store.dataStore.setUnoId).toHaveBeenCalledWith('3EB0ZAPO', expect.any(String))
    expect(store.dataStore.setKey).toHaveBeenCalledWith('3EB0ZAPO', expect.objectContaining({ id: '3EB0ZAPO' }))
    expect(store.dataStore.setLastIncomingKey).toHaveBeenCalledWith(
      '5566998888888@s.whatsapp.net',
      expect.objectContaining({ id: '3EB0ZAPO' }),
    )
    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    expect(payload.entry[0].changes[0].value.messages[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(payload.entry[0].changes[0].value.messages[0].id).not.toBe('3EB0ZAPO')
  })

  test('preserves location labels and existing UnoID, suppressing repeated delivery', async () => {
    const unoId = 'b85f5910-b9bd-11f1-9eb5-d9bee238f01e'
    ;(store.dataStore.loadUnoId as jest.Mock).mockResolvedValue(unoId)
    const source = { key: { id: 'provider-location', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      message: { locationMessage: { degreesLatitude: -11.499317, degreesLongitude: -54.873917, name: 'Viper Tec', address: 'Cláudia, MT' } }, messageTimestamp: 1790435992 }
    await service.process('5511888888888', [source, source], 'notify')
    expect(outgoing.send).toHaveBeenCalledTimes(1)
    const messages = (outgoing.send as jest.Mock).mock.calls[0][1].entry[0].changes[0].value.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: unoId, type: 'location', location: { latitude: -11.499317, longitude: -54.873917, name: 'Viper Tec', address: 'Cláudia, MT' } })
    expect(source.key.id).toBe('provider-location')
  })

  test('preserves view-once after media storage, maps the original ID once and deduplicates', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockResolvedValue('uno-view-once')
    ;(store.mediaStore.saveDownloadedMedia as jest.Mock).mockImplementation(async message => {
      message.message.imageMessage.url = 'https://example.test/stored.jpg'
      return message
    })
    const source = { key: { id: 'provider-view-once', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } },
      __unoapiMediaBytes: Buffer.from([1, 2, 3]), messageTimestamp: 1790672409 }
    await service.process('5511888888888', [source, source], 'notify')
    expect(store.mediaStore.saveDownloadedMedia).toHaveBeenCalledTimes(1)
    expect(outgoing.send).toHaveBeenCalledTimes(1)
    expect((outgoing.send as jest.Mock).mock.calls[0][1].entry[0].changes[0].value.messages).toEqual([
      expect.objectContaining({ id: 'uno-view-once', type: 'image', message_type: 'view_once',
        image: expect.objectContaining({ url: 'https://example.test/stored.jpg' }) }),
    ])
  })

  test('marks synthetic call webhooks for Typebot exclusion', async () => {
    await service.process('5566999999999', [{
      key: {
        id: 'call-webhook-provider-id',
        remoteJid: '5566998888888@s.whatsapp.net',
        fromMe: false,
        __unoapiSkipTypebot: true,
      },
      message: { conversation: 'Tentou ligar no WhatsApp' },
      messageTimestamp: 1,
    }], 'notify')

    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    expect(payload.__unoapiSkipTypebot).toBe(true)
    expect(payload.entry[0].changes[0].value.messages[0].text.body).toBe('Tentou ligar no WhatsApp')
  })

  test.each([
    ['direct', {
      remoteJid: '123@lid',
      remoteJidAlt: '5566998888888@s.whatsapp.net',
      fromMe: false,
    }],
    ['group', {
      remoteJid: '120363427999345040@g.us',
      participant: '123@lid',
      participantAlt: '5566998888888@s.whatsapp.net',
      fromMe: false,
      isGroup: true,
    }],
  ])('forwards an unavailable view-once placeholder for %s messages with ignore-own filtering enabled', async (_kind, key) => {
    config.ignoreOwnMessages = true
    config.ignoreGroupMessages = false
    const filter = new MessageFilter('5566999999999', config)
    config.shouldIgnoreJid = filter.isIgnoreJid.bind(filter)
    config.shouldIgnoreKey = filter.isIgnoreKey.bind(filter)

    await service.process('5566999999999', [{
      key: { id: 'view-once-unavailable', ...key },
      messageTimestamp: 1,
      pushName: 'Contato',
      messageStubType: 'FUTUREPROOF',
      messageStubParameters: ['view_once_unavailable'],
    }], 'notify')

    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    const value = payload.entry[0].changes[0].value
    expect(value.messages[0]).toEqual(expect.objectContaining({
      type: 'text',
      text: expect.objectContaining({
        body: 'Mídia de visualização única indisponível neste dispositivo.',
      }),
    }))
  })

  test.each([
    ['direct', { remoteJid: '123@lid', remoteJidAlt: '5566998888888@s.whatsapp.net' }],
    ['group', {
      remoteJid: '120363427999345040@g.us',
      participant: '123@lid',
      participantAlt: '5566998888888@s.whatsapp.net',
      isGroup: true,
    }],
  ])('uses the Uno id for %s media storage and webhook references', async (_kind, key) => {
    ;(messageMetadata.resolve as jest.Mock).mockImplementation(async (_phone: string, message: any) => ({
      ...message,
      __unoapiMediaBytes: Buffer.from([1, 2, 3]),
    }))
    ;(store.mediaStore.saveDownloadedMedia as jest.Mock).mockImplementation(async (message: any) => ({
      ...message,
      message: {
        ...message.message,
        imageMessage: {
          ...message.message.imageMessage,
          url: `https://files.example/${message.key.id}.jpg`,
        },
      },
    }))

    await service.process('5566999999999', [{
      key: { id: '3EB0MEDIA', fromMe: false, ...key },
      message: { imageMessage: { mimetype: 'image/jpeg' } },
      messageTimestamp: 1,
    }], 'notify')

    const storedMessage = (store.mediaStore.saveDownloadedMedia as jest.Mock).mock.calls[0][0]
    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    const webhookMessage = payload.entry[0].changes[0].value.messages[0]

    expect(storedMessage.key.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(webhookMessage.id).toBe(storedMessage.key.id)
    expect(webhookMessage.image.id).toBe(`5566999999999/${storedMessage.key.id}`)
    expect(webhookMessage.image.url).toContain(storedMessage.key.id)
  })

  test('downloads forwarded audio through the active client after AMQP config reload', async () => {
    const unoId = '32f75c70-89af-11f1-bad7-835d7d7a6fda'
    let providerIdAtResolve = ''
    ;(store.dataStore.setUnoId as jest.Mock).mockResolvedValue(unoId)
    config.getMessageMetadata = jest.fn(async (message: any) => message)
    ;(messageMetadata.resolve as jest.Mock).mockImplementation(async (_phone: string, message: any) => {
      providerIdAtResolve = message.key.id
      return {
        ...message,
        __unoapiMediaBytes: Buffer.from([7, 8, 9]),
      }
    })
    ;(store.mediaStore.saveDownloadedMedia as jest.Mock).mockImplementation(async (message: any) => ({
      ...message,
      message: {
        ...message.message,
        audioMessage: {
          ...message.message.audioMessage,
          url: `https://files.example/${message.key.id}.oga`,
        },
      },
    }))

    await service.process('5566999554300', [{
      key: {
        id: '3A941DE965A8027E92DE',
        remoteJid: '136026060279961@lid',
        remoteJidAlt: '556699658737@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg; codecs=opus',
          directPath: '/audio',
          mediaKey: Uint8Array.from([1, 2, 3]),
          fileSha256: Uint8Array.from([4, 5, 6]),
          fileEncSha256: Uint8Array.from([7, 8, 9]),
        },
      },
      messageTimestamp: 1,
    }], 'notify')

    expect(config.getMessageMetadata).not.toHaveBeenCalled()
    expect(messageMetadata.resolve).toHaveBeenCalledWith('5566999554300', expect.any(Object))
    expect(providerIdAtResolve).toBe('3A941DE965A8027E92DE')
    expect(store.mediaStore.saveDownloadedMedia).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.objectContaining({ id: unoId }) }),
      Buffer.from([7, 8, 9]),
    )
    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    expect(payload.entry[0].changes[0].value.messages[0]).toEqual(expect.objectContaining({
      id: unoId,
      type: 'audio',
      audio: expect.objectContaining({
        id: `5566999554300/${unoId}`,
        url: expect.stringContaining(unoId),
      }),
    }))
  })

  test('does not expose temporary WhatsApp media when Zapo bytes are unavailable', async () => {
    await expect(service.process('5566999999999', [{
      key: {
        id: '3EB0MEDIAFALLBACK',
        remoteJid: '123@lid',
        remoteJidAlt: '5566998888888@s.whatsapp.net',
        fromMe: true,
      },
      message: { imageMessage: { mimetype: 'image/jpeg', directPath: '/media' } },
      messageTimestamp: 1,
    }], 'notify')).rejects.toThrow('zapo_media_bytes_unavailable')
    expect(store.mediaStore.saveMedia).not.toHaveBeenCalled()
    expect(outgoing.send).not.toHaveBeenCalled()
  })

  test('normalizes a legacy Brazilian mobile PN only at the Zapo webhook boundary', async () => {
    await service.process('5566999999999', [{
      key: {
        id: 'legacy-mobile',
        remoteJid: '123@lid',
        remoteJidAlt: '556699554300@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'oi' },
      messageTimestamp: 1,
    }], 'notify')

    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    const value = payload.entry[0].changes[0].value
    expect(value.contacts[0]).toEqual(expect.objectContaining({
      wa_id: '5566999554300',
      user_id: '123@lid',
    }))
    expect(value.messages[0]).toEqual(expect.objectContaining({
      from: '5566999554300',
      from_user_id: '123@lid',
    }))
  })

  test('normalizes a legacy Brazilian mobile group sender without replacing its LID', async () => {
    await service.process('5566999999999', [{
      key: {
        id: 'legacy-group-mobile',
        remoteJid: '120363427999345040@g.us',
        participant: '456@lid',
        participantAlt: '556699554300@s.whatsapp.net',
        fromMe: false,
        isGroup: true,
      },
      message: { conversation: 'grupo' },
      messageTimestamp: 1,
    }], 'notify')

    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    const value = payload.entry[0].changes[0].value
    expect(value.contacts[0]).toEqual(expect.objectContaining({
      wa_id: '5566999554300',
      user_id: '456@lid',
      group_id: '120363427999345040@g.us',
    }))
    expect(value.messages[0]).toEqual(expect.objectContaining({
      from: '5566999554300',
      from_user_id: '456@lid',
    }))
  })

  test('keeps a Brazilian landline unchanged in the Zapo webhook', async () => {
    await service.process('5566999999999', [{
      key: {
        id: 'landline',
        remoteJid: '789@lid',
        remoteJidAlt: '556635211234@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'fixo' },
      messageTimestamp: 1,
    }], 'notify')

    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    const value = payload.entry[0].changes[0].value
    expect(value.contacts[0].wa_id).toBe('556635211234')
    expect(value.messages[0].from).toBe('556635211234')
  })

  test('deduplicates repeated provider events', async () => {
    const event = {
      key: { id: 'same', remoteJid: '123@lid', fromMe: false },
      message: { conversation: 'oi' },
      messageTimestamp: 1,
    }
    await service.process('5566999999999', [event], 'notify')
    await service.process('5566999999999', [event], 'notify')
    expect(outgoing.send).toHaveBeenCalledTimes(1)
  })

  test('does not deduplicate the same group event across different sessions', async () => {
    const event = {
      key: {
        id: 'shared-group-message',
        remoteJid: '120363427999345040@g.us',
        participant: '86110369755163@lid',
        fromMe: true,
        isGroup: true,
      },
      message: { conversation: 'eco enviado pelo aparelho' },
      messageTimestamp: 1,
    }

    await service.process('5566996269251', [event], 'notify')
    await service.process('5566996328386', [event], 'notify')

    expect(outgoing.send).toHaveBeenCalledTimes(2)
    expect(outgoing.send).toHaveBeenNthCalledWith(1, '5566996269251', expect.any(Object))
    expect(outgoing.send).toHaveBeenNthCalledWith(2, '5566996328386', expect.any(Object))
  })

  test('does not let a group sender-key event suppress the message with the same provider id', async () => {
    const key = {
      id: 'same-group-id',
      remoteJid: '120363427999345040@g.us',
      participant: '86110369755163@lid',
      participantAlt: '5566996328386@s.whatsapp.net',
      fromMe: true,
      isGroup: true,
    }

    await service.process('5566996328386', [{
      key,
      message: { senderKeyDistributionMessage: { groupId: key.remoteJid } },
      messageTimestamp: 1,
    }], 'notify')
    await service.process('5566996328386', [{
      key,
      message: { conversation: 'grupo aparelho depois patch' },
      messageTimestamp: 1,
    }], 'notify')

    expect(outgoing.send).toHaveBeenCalledTimes(1)
    expect(outgoing.send).toHaveBeenCalledWith('5566996328386', expect.objectContaining({
      entry: [expect.objectContaining({
        changes: [expect.objectContaining({
          value: expect.objectContaining({
            messages: [expect.objectContaining({
              text: { body: 'grupo aparelho depois patch' },
              group_id: key.remoteJid,
            })],
          }),
        })],
      })],
    }))
  })

  test('maps an incoming poll vote context from the Zapo id to the parent Uno id', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockImplementation(async (id: string) => (
      id === 'poll-provider-id' ? 'poll-uno-id' : undefined
    ))

    await service.process('5566996328386', [{
      key: {
        id: 'vote-provider-id',
        remoteJid: '120363427999345040@g.us',
        participant: '86110369755163@lid',
        fromMe: false,
      },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: {
            id: 'poll-provider-id',
            remoteJid: '120363427999345040@g.us',
            fromMe: false,
          },
          vote: { selectedOptionNames: ['Pizza'] },
        },
      },
      messageTimestamp: 1,
    }], 'notify')

    expect(outgoing.send).toHaveBeenCalledWith('5566996328386', expect.objectContaining({
      entry: [expect.objectContaining({
        changes: [expect.objectContaining({
          value: expect.objectContaining({
            messages: [expect.objectContaining({
              text: { body: '*Resultado de enquete*\nTotal de votos: 1\n- Pizza: 1' },
              context: { message_id: 'poll-uno-id', id: 'poll-uno-id' },
            })],
          }),
        })],
      })],
    }))
  })

  test('maps an order request reference and forwards structured catalog metadata', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockImplementation(async (id: string) => (
      id === 'request-provider-id' ? 'request-uno-id' : undefined
    ))
    ;(messageMetadata.resolve as jest.Mock).mockImplementation(async (_phone: string, message: any) => ({
      ...message,
      __unoapiCatalog: {
        orderResolution: {
          resolution_status: 'resolved',
          currency: 'BRL',
          total_amount_1000: 129900,
          items: [{
            product_id: 'product-1',
            title: 'Óculos Solar',
            quantity: 1,
            currency: 'BRL',
            unit_price_amount_1000: 129900,
            subtotal_amount_1000: 129900,
          }],
        },
      },
    }))

    await service.process('5566996328386', [{
      key: {
        id: 'order-provider-id',
        remoteJid: 'contact@lid',
        remoteJidAlt: '5566998888888@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        orderMessage: {
          orderId: 'order-1',
          itemCount: 1,
          status: 1,
          orderRequestMessageId: { id: 'request-provider-id' },
        },
      },
      messageTimestamp: 1,
    }], 'notify')

    const payload: any = (outgoing.send as jest.Mock).mock.calls[0][1]
    const webhookMessage = payload.entry[0].changes[0].value.messages[0]
    expect(webhookMessage).toEqual(expect.objectContaining({
      type: 'order',
      order: expect.objectContaining({
        order_id: 'order-1',
        resolution_status: 'resolved',
        items: [expect.objectContaining({ product_id: 'product-1' })],
      }),
      context: { message_id: 'request-uno-id', id: 'request-uno-id' },
    }))
    expect(messageMetadata.resolve).toHaveBeenCalledWith(
      '5566996328386',
      expect.objectContaining({
        message: {
          orderMessage: expect.objectContaining({
            orderRequestMessageId: expect.objectContaining({ id: 'request-uno-id' }),
          }),
        },
      }),
    )
    expect(webhookMessage.fallback_text).toContain('Óculos Solar')
  })

  test('maps receipt ids and suppresses status regression', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockResolvedValue('uno-1')
    ;(store.dataStore.loadStatus as jest.Mock).mockResolvedValue('read')
    await service.process('5566999999999', [{
      key: { id: 'provider-1', remoteJid: '123@lid', fromMe: true },
      update: { status: 'DELIVERY_ACK' },
    }], 'update')
    expect(outgoing.send).not.toHaveBeenCalled()
  })

  test('forwards receipt and persists progression with the associated Uno id', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockResolvedValue('uno-1')
    ;(store.dataStore.loadStatus as jest.Mock).mockResolvedValue(undefined)
    await service.process('5566999999999', [{
      key: { id: '3EB0PROVIDER', remoteJid: '123@lid', fromMe: true },
      update: { status: 'READ' },
    }], 'update')

    expect(outgoing.send).toHaveBeenCalledWith(
      '5566999999999',
      expect.objectContaining({
        entry: [expect.objectContaining({
          changes: [expect.objectContaining({
            value: expect.objectContaining({
              statuses: [expect.objectContaining({ id: 'uno-1', status: 'read' })],
            }),
          })],
        })],
      }),
    )
    expect(store.dataStore.setStatus).toHaveBeenCalledWith('uno-1', 'read')
  })
})
