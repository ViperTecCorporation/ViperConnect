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
    process.env.WEBHOOK_ASYNC = 'false'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ;({ OutgoingCloudApi: OutgoingCloudApiClass } = require('../../src/services/outgoing_cloud_api'))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mockFetch = require('node-fetch') as jest.MockedFunction<typeof fetchType>
    config = defaultConfig
    config.ignoreGroupMessages = true
    webhook.timeoutMs = 1
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
      addToBlackListOnOutgoingMessageWithTtl: ttl
    }
    mockFetch.mockReset()
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
})
