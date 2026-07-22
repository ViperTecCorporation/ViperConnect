import { mock } from 'jest-mock-extended'
jest.mock('../../src/services/blacklist')
jest.mock('node-fetch')
import type { Outgoing } from '../../src/services/outgoing'
import { Store, getStore } from '../../src/services/store'
import type fetchType from 'node-fetch'
import { DataStore } from '../../src/services/data_store'
import { MediaStore } from '../../src/services/media_store'
import { Config, getConfig, defaultConfig, getMessageMetadataDefault, Webhook } from '../../src/services/config'
import logger from '../../src/services/logger'
import { isInBlacklistInMemory, addToBlacklistInMemory, isInBlacklist } from '../../src/services/blacklist'

let mockFetch: jest.MockedFunction<typeof fetchType>
const addToBlacklistMock = addToBlacklistInMemory as jest.MockedFunction<typeof addToBlacklistInMemory>
const webhook = mock<Webhook>()

let isInBlacklistMock = jest.fn()
let store: Store
let getConfig: getConfig
let config: Config
let getStore: getStore
const url = 'http://example.com'
let phone: string | undefined
let wa_id: string | undefined
let service: Outgoing
let OutgoingCloudApiClass: typeof import('../../src/services/outgoing_cloud_api').OutgoingCloudApi

describe('service outgoing whatsapp cloud api', () => {
  let textPayload: any, outgoingPayload: any, updatePayload: any

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.WEBHOOK_ASYNC = 'false'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ;({ OutgoingCloudApi: OutgoingCloudApiClass } = require('../../src/services/outgoing_cloud_api'))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mockFetch = require('node-fetch') as jest.MockedFunction<typeof fetchType>
    config = {
      ...defaultConfig,
      webhooks: [{
        ...defaultConfig.webhooks[0],
        url,
        enabled: true,
        sendIncomingMessages: true,
        sendOutgoingMessages: true,
        sendGroupMessages: true,
        sendUpdateMessages: true,
        sendNewsletterMessages: true,
      }],
    }
    config.ignoreGroupMessages = true
    Object.assign(webhook, config.webhooks[0], { timeoutMs: 1 })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getStore = async (_phone: string): Promise<Store> => store
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getConfig = async (_phone: string) => {
      config.getStore = getStore
      config.getMessageMetadata = getMessageMetadataDefault
      return config
    }
    store = mock<Store>()
    store.dataStore = mock<DataStore>()
    store.mediaStore = mock<MediaStore>()
    isInBlacklistMock = jest.fn()
    phone = `${new Date().getTime() / 4}`
    wa_id = `${new Date().getTime() / 2}`
    service = new OutgoingCloudApiClass(getConfig, isInBlacklistMock, addToBlacklistMock)
    textPayload = {
      text: {
        body: 'test'
      },
      type: 'text',
      to: 'abc',
    }
    outgoingPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id }],
                metadata: { display_phone_number: 'abc' },
                messages: [ { from: 'abc' }, ]
              }
            },
          ],
        },
      ],
    }
    updatePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [ { status: 'deleted' } ]
              },
            },
          ],
        },
      ],
    }
  })

  test('send text with success', async () => {
    const mockUrl = `${url}/${phone}`
    logger.debug(`Mock url ${mockUrl}`)
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    const response = { ok: true, status: 200, text: async () => 'ok' } as any
    mockFetch.mockResolvedValue(response)
    await service.send(phone!, textPayload)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test('not sendHttp in webhook when is in blacklist', async () => {
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    isInBlacklistMock.mockReturnValueOnce(Promise.resolve('1'))
    await service.sendHttp(phone!, webhook, textPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('not sendHttp in webhook when is disabled', async () => {
    webhook.enabled = false
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    await service.sendHttp(phone!, webhook, textPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
    expect(isInBlacklistMock).toHaveBeenCalledTimes(0)
  })

  test('not sendHttp in webhook when is sendGroupMessages false', async () => {
    webhook.sendGroupMessages = false
    outgoingPayload.entry[0].changes[0].value.contacts[0].group_id = 'um@g.us'
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    await service.sendHttp(phone!, webhook, outgoingPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('not sendHttp in webhook when is sendNewsletterMessages false', async () => {
    webhook.sendNewsletterMessages = false
    outgoingPayload.entry[0].changes[0].value.contacts[0].group_id = 'um@newsletter'
    outgoingPayload
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    await service.sendHttp(phone!, webhook, outgoingPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('not sendHttp in webhook when is sendOutgoingMessages false', async () => {
    webhook.sendOutgoingMessages = false
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    await service.sendHttp(phone!, webhook, outgoingPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('not sendHttp in webhook when is sendUpdateMessages false', async () => {
    webhook.sendUpdateMessages = false
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    await service.sendHttp(phone!, webhook, updatePayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('not sendHttp in webhook when is sendIncomingMessages false', async () => {
    webhook.sendIncomingMessages = false
    // outgoingPayload.entry[0].changes[0].value.messages[0].from = phone
    mockFetch.mockReset()
    expect(mockFetch).toHaveBeenCalledTimes(0)
    await service.sendHttp(phone!, webhook, outgoingPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('add to blacklist where addToBlackListOnOutgoingMessageWithTtl', async () => {
    const ttl = 1
    const w: Partial<Webhook> = {
      id: `${new Date().getTime() / 5}`,
      urlAbsolute: `${url}/blacklist`,
      enabled: true,
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
      addToBlackListOnOutgoingMessageWithTtl: ttl,
    }
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' } as any)
    await service.sendHttp(phone!, w as Webhook, outgoingPayload, {})
    expect(addToBlacklistMock).toHaveBeenCalledWith(phone!, w.id, wa_id, ttl)
  })

  test('adapt status reply media for chatwoot preserving text and adding media message', async () => {
    const response = { ok: true, status: 200, text: async () => 'ok' } as any
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(response)
    const chatwootWebhook = {
      id: 'cw',
      url: 'https://chatwoot.local/webhooks/whatsapp',
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
    } as Webhook
    const statusReplyPayload: any = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '5566999999999' }],
                metadata: { display_phone_number: phone },
                messages: [
                  {
                    from: '5566999999999',
                    id: 'MSG1',
                    type: 'text',
                    text: { body: 'resposta ao status' },
                    context: {
                      status: {
                        id: 'STATUS1',
                        type: 'imageMessage',
                        media: {
                          url: 'https://files.local/status.jpg',
                          mime_type: 'image/jpeg',
                          file_name: 'status.jpg',
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    await service.sendHttp(phone!, chatwootWebhook, statusReplyPayload, {})
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callArgs: any = mockFetch.mock.calls[0]
    const body = JSON.parse(callArgs[1].body)
    const msgs = body?.entry?.[0]?.changes?.[0]?.value?.messages || []
    expect(msgs).toHaveLength(2)
    expect(msgs[0].type).toBe('text')
    expect(msgs[0].text?.body).toBe('resposta ao status')
    expect(msgs[1].type).toBe('image')
    expect(msgs[1].image?.url).toBe('https://files.local/status.jpg')
    expect(msgs[1].image?.caption).toBe('resposta ao status')
  })

  test('normalizes typebot metadata phone id with plus sign', async () => {
    const response = { ok: true, status: 200, text: async () => 'ok' } as any
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(response)
    const typebotWebhook = {
      id: 'typebot',
      urlAbsolute: 'https://bot.local/api/v1/workspaces/ws/whatsapp/cred/webhook',
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
      typebot: true,
    } as Webhook
    const payload: any = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phone, phone_number_id: phone },
                contacts: [{ profile: { name: 'Contato', picture: 'https://files.local/avatar.jpg' }, wa_id }],
                messages: [
                  {
                    from: wa_id,
                    id: 'MSG1',
                    type: 'text',
                    text: { body: 'oi' },
                    timestamp: '123',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }

    await service.sendHttp(phone!, typebotWebhook, payload, {})

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse((mockFetch.mock.calls[0] as any)[1].body)
    const value = body.entry[0].changes[0].value
    expect(value.metadata.phone_number_id).toBe(`+${phone}`)
    expect(value.metadata.display_phone_number).toBe(`+${phone}`)
    expect(value.contacts[0].profile.picture).toBeUndefined()
  })

  test('does not send unsupported typebot payload without message type', async () => {
    mockFetch.mockReset()
    const typebotWebhook = {
      id: 'typebot',
      urlAbsolute: 'https://bot.local/api/v1/workspaces/ws/whatsapp/cred/webhook',
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
      typebot: true,
    } as Webhook
    const payload: any = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phone, phone_number_id: phone },
                contacts: [{ profile: { name: '' }, wa_id: phone }],
                messages: [
                  {
                    from: phone,
                    id: 'MSG1',
                    timestamp: '123',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }

    await service.sendHttp(phone!, typebotWebhook, payload, {})

    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  test('sendHttp does not leak LID into Cloud API phone fields', async () => {
    process.env.WEBHOOK_PREFER_PN_OVER_LID = 'true'
    jest.resetModules()
    ;({ OutgoingCloudApi: OutgoingCloudApiClass } = require('../../src/services/outgoing_cloud_api'))
    mockFetch = require('node-fetch') as jest.MockedFunction<typeof fetchType>
    service = new OutgoingCloudApiClass(getConfig, isInBlacklistMock, addToBlacklistMock)
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' } as any)

    const lidWithDevice = '190280070385782:35@lid'
    const lid = '190280070385782@lid'
    const safeWebhook = {
      id: 'webhook',
      urlAbsolute: 'https://example.com/webhook',
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
    } as Webhook
    const payload: any = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phone, phone_number_id: phone },
                contacts: [{ profile: { name: 'Contato' }, wa_id: lidWithDevice, user_id: lidWithDevice }],
                messages: [
                  {
                    from: lidWithDevice,
                    from_user_id: lidWithDevice,
                    id: 'MSG1',
                    type: 'text',
                    text: { body: 'oi' },
                    timestamp: '123',
                  },
                ],
                statuses: [{ id: 'MSG1', status: 'delivered', recipient_id: lidWithDevice }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }

    await service.sendHttp(phone!, safeWebhook, payload, {})

    const body = JSON.parse((mockFetch.mock.calls[0] as any)[1].body)
    const value = body.entry[0].changes[0].value
    expect(value.contacts[0].wa_id).toBe('')
    expect(value.contacts[0].user_id).toBe(lid)
    expect(value.messages[0].from).toBe('')
    expect(value.messages[0].from_user_id).toBe(lid)
    expect(value.statuses[0].recipient_id).toBe('')
    process.env.WEBHOOK_PREFER_PN_OVER_LID = 'false'
  })

  test('sendHttp keeps status recipient_id as PN even when LID mapping exists', async () => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' } as any)
    ;(store.dataStore.getLidForPn as jest.Mock).mockResolvedValue('190280070385782@lid')

    const safeWebhook = {
      id: 'webhook',
      urlAbsolute: 'https://example.com/webhook',
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
    } as Webhook
    const payload: any = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phone, phone_number_id: phone },
                contacts: [{ profile: { name: 'Contato' }, wa_id: '5566996269251' }],
                messages: [],
                statuses: [{ id: 'MSG1', status: 'delivered', recipient_id: '5566996269251' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }

    await service.sendHttp(phone!, safeWebhook, payload, {})

    const body = JSON.parse((mockFetch.mock.calls[0] as any)[1].body)
    expect(body.entry[0].changes[0].value.statuses[0].recipient_id).toBe('5566996269251')
  })

  test('classifies only transient HTTP responses as circuit breaker failures', () => {
    const { isWebhookCircuitFailureStatus } = require('../../src/services/outgoing_cloud_api')
    expect([408, 425, 429, 500, 503].every(isWebhookCircuitFailureStatus)).toBe(true)
    expect([400, 401, 403, 404, 409, 422].some(isWebhookCircuitFailureStatus)).toBe(false)
  })

  test('does not open the webhook circuit for permanent 4xx responses', async () => {
    const target = {
      id: `cb-4xx-${phone}`,
      urlAbsolute: 'https://example.com/cb-4xx',
      enabled: true,
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
      timeoutMs: 1000,
    } as Webhook
    mockFetch.mockReset()
    const unavailable = { ok: false, status: 503, statusText: 'Unavailable', text: async () => 'offline' } as any
    const invalid = { ok: false, status: 422, statusText: 'Unprocessable', text: async () => 'invalid payload' } as any
    mockFetch
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)

    await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 503')
    await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 503')
    await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 422')
    await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 503')
    await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 503')
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  test('opens after the threshold and allows only one half-open probe', async () => {
    const target = {
      id: `cb-half-open-${phone}`,
      urlAbsolute: 'https://example.com/cb-half-open',
      enabled: true,
      sendIncomingMessages: true,
      sendOutgoingMessages: true,
      sendGroupMessages: true,
      sendUpdateMessages: true,
      sendNewsletterMessages: true,
      timeoutMs: 1000,
    } as Webhook
    let now = 10_000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mockFetch.mockReset()
      mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable', text: async () => 'offline' } as any)
      await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 503')
      await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toThrow('Webhook response 503')
      await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toMatchObject({ code: 'WEBHOOK_CB_OPEN' })
      await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toMatchObject({ code: 'WEBHOOK_CB_OPEN' })
      expect(mockFetch).toHaveBeenCalledTimes(3)

      now += 120_001
      let finishProbe: ((value: any) => void) | undefined
      mockFetch.mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve }) as any)
      const probe = service.sendHttp(phone!, target, textPayload, {})
      await Promise.resolve()
      await expect(service.sendHttp(phone!, target, textPayload, {})).rejects.toMatchObject({ code: 'WEBHOOK_CB_OPEN' })
      finishProbe?.({ ok: true, status: 200, text: async () => 'ok' })
      await expect(probe).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(4)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
