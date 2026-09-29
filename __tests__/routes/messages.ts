import request from 'supertest'
import { mock } from 'jest-mock-extended'

import { App } from '../../src/app'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'
import { Response } from '../../src/services/response'
import { getStore, Store } from '../../src/services/store'
import { SessionStore } from '../../src/services/session_store'
import { OnNewLogin } from '../../src/services/socket'
import { addToBlacklist } from '../../src/services/blacklist'
import { Reload } from '../../src/services/reload'
import { Logout } from '../../src/services/logout'

jest.mock('../../src/services/rate_limit', () => ({
  allowSend: jest.fn().mockResolvedValue({ allowed: true }),
}))

const addToBlacklist = mock<addToBlacklist>()

const sessionStore = mock<SessionStore>()
const store = mock<Store>()
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getConfigTest: getConfig = async (_phone: string) => {
  defaultConfig.getStore = getTestStore
  return defaultConfig
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getTestStore: getStore = async (_phone: string, _config: object) => {
  return store
}

let phone: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let json: any
let app: App
let incoming: Incoming
let outgoing: Outgoing

describe('messages routes', () => {
  test.each(['image', 'video', 'audio'])('preserves %s view_once in the enqueued payload', async type => {
    const spy = jest.spyOn(incoming, 'send').mockResolvedValue({ ok: { messages: [{ id: 'once' }] } })
    const payload = { to: '5511999999999', type, [type]: { link: 'https://example.test/media', view_once: true } }
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send(payload)
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith(phone, expect.objectContaining(payload), expect.anything())
  })
  test.each([
    { type: 'image', image: { view_once: 'true' } },
    { type: 'document', document: { view_once: true } },
    { type: 'image', view_once: true },
  ])('rejects invalid view_once before enqueueing (%j)', payload => {
    const spy = jest.spyOn(incoming, 'send')
    return request(app.server).post(`/v15.0/${phone}/messages`).send({ to: '5511999999999', ...payload }).then(res => {
      expect(res.status).toBe(400); expect(spy).not.toHaveBeenCalled()
    })
  })
  beforeEach(() => {
    phone = `${new Date().getTime()}`
    json = { data: `${new Date().getTime()}` }
    outgoing = mock<Outgoing>()
    incoming = mock<Incoming>()
    const onNewLogin = mock<OnNewLogin>()
    const reload = mock<Reload>()
    const logout = mock<Logout>()
    app = new App(incoming, outgoing, '', getConfigTest, sessionStore, onNewLogin, addToBlacklist, reload, logout)
  })

  test('whatsapp with sucess', async () => {
    const sendSpy = jest.spyOn(incoming, 'send')
    const r: Response = { ok: { any: '1' } }
    const p: Promise<Response> = new Promise((resolve) => resolve(r))
    jest.spyOn(incoming, 'send').mockReturnValue(p)
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send(json)
    expect(res.status).toEqual(200)
    expect(sendSpy).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        ...json,
        _requestId: expect.any(String),
      }),
      expect.objectContaining({
        endpoint: 'messages',
        requestId: expect.any(String),
      }),
    )
  })

  test('enqueues normalized location preserving reply context', async () => {
    const sendSpy = jest.spyOn(incoming, 'send').mockResolvedValue({ ok: { messages: [{ id: 'queued' }] } })
    const payload = { messaging_product: 'whatsapp', to: '5511999999999', type: 'location', context: { message_id: 'original' }, location: { latitude: '0', longitude: '-56.1', name: 'Praça' } }
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send(payload)
    expect(res.status).toBe(200)
    expect(sendSpy).toHaveBeenCalledWith(phone, expect.objectContaining({ ...payload, location: { latitude: 0, longitude: -56.1, name: 'Praça' } }), expect.anything())
  })

  test.each(['hd', 'sd'])('accepts video quality %s without dropping it before the worker', async quality => {
    const sendSpy = jest.spyOn(incoming, 'send').mockResolvedValue({ ok: { messages: [{ id: 'video-test' }] } })
    const video = { link: 'https://example.com/video.mp4', quality }
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send({ to: '5511999999999', type: 'video', video })
    expect(res.status).toBe(200)
    expect(sendSpy).toHaveBeenCalledWith(phone, expect.objectContaining({ video }), expect.anything())
  })

  test('rejects unsupported video quality before enqueueing', async () => {
    const sendSpy = jest.spyOn(incoming, 'send').mockClear()
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send({ to: '5511999999999', type: 'video', video: { link: 'https://example.com/video.mp4', quality: '4k' } })
    expect(res.status).toBe(400)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  test.each([undefined, {}, { latitude: 91, longitude: 0 }, { latitude: null, longitude: 0 }])('rejects invalid location before queueing: %s', async (location) => {
    const sendSpy = jest.spyOn(incoming, 'send')
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send({ to: '5511999999999', type: 'location', location })
    expect(res.status).toBe(400)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  test('normalizes raw Baileys interactive payload before sending', async () => {
    const sendSpy = jest.spyOn(incoming, 'send')
    const r: Response = { ok: { success: true } }
    jest.spyOn(incoming, 'send').mockResolvedValue(r)
    const raw = {
      jid: '5511999999999@s.whatsapp.net',
      message: {
        text: 'Escolha uma opcao:',
        buttons: [
          {
            buttonId: 'opcao_1',
            buttonText: { displayText: 'Opcao 1' },
            type: 1,
          },
        ],
      },
    }

    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send(raw)

    expect(res.status).toEqual(200)
    expect(sendSpy).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        ...raw,
        to: raw.jid,
        type: 'baileys',
        _requestId: expect.any(String),
      }),
      expect.objectContaining({
        endpoint: 'messages',
        requestId: expect.any(String),
      }),
    )
  })

  test('accepts Graph-like phone_number_id messages route', async () => {
    const sendSpy = jest.spyOn(incoming, 'send')
    const r: Response = { ok: { success: true } }
    jest.spyOn(incoming, 'send').mockResolvedValue(r)
    const phoneNumberId = `phone-id-${new Date().getTime()}`

    const res = await request(app.server).post(`/v19.0/${phoneNumberId}/messages`).send({
      messaging_product: 'whatsapp',
      to: '5566999999999',
      type: 'text',
      text: { body: 'teste' },
    })

    expect(res.status).toEqual(200)
    expect(sendSpy).toHaveBeenCalledWith(
      phoneNumberId,
      expect.objectContaining({
        type: 'text',
        _requestId: expect.any(String),
      }),
      expect.objectContaining({ endpoint: 'messages' }),
    )
  })

  test('accepts Base64 media above the default Express JSON limit and queues only a staged reference', async () => {
    const bytes = Buffer.alloc(128 * 1024, 7)
    const mediaStore = {
      getFilePath: jest.fn().mockReturnValue(`${phone}/base64-image.jpeg`),
      saveMediaBuffer: jest.fn().mockResolvedValue(true),
      getFileUrl: jest.fn().mockResolvedValue(`/data/medias/${phone}/base64-image.jpeg`),
      getDownloadUrl: jest.fn().mockResolvedValue(`https://uno.test/v15.0/download/${phone}/base64-image.jpeg`),
      type: 'file',
    }
    ;(store as any).mediaStore = mediaStore
    jest.spyOn(incoming, 'send').mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'queued' }] },
    })

    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send({
      messaging_product: 'whatsapp',
      to: '5566999999999',
      type: 'image',
      image: {
        base64: bytes.toString('base64'),
        mime_type: 'image/jpeg',
        filename: 'foto.jpg',
      },
    })

    expect(res.status).toBe(200)
    expect(mediaStore.saveMediaBuffer).toHaveBeenCalledWith(
      `${phone}/base64-image.jpeg`,
      bytes,
      'image/jpeg',
    )
    const queuedPayload = (incoming.send as jest.Mock).mock.calls[0][1]
    expect(queuedPayload.image).not.toHaveProperty('base64')
    expect(queuedPayload.image.link).toBe(`/data/medias/${phone}/base64-image.jpeg`)
  })

  test('rejects a Base64 media payload that also provides a link', async () => {
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send({
      messaging_product: 'whatsapp',
      to: '5566999999999',
      type: 'image',
      image: {
        link: 'https://example.test/image.jpg',
        base64: Buffer.from('image').toString('base64'),
        mime_type: 'image/jpeg',
      },
    })
    expect(res.status).toBe(400)
    expect(incoming.send).not.toHaveBeenCalled()
  })

  test('delivery recovery route forces session refresh for the original message id', async () => {
    const recoverSpy = jest.spyOn(incoming, 'recoverDelivery').mockResolvedValue({
      ok: {
        messaging_product: 'whatsapp',
        messages: [{ id: 'uno-message-1' }],
        recovery: { attempted: true },
      },
    } as any)

    const res = await request(app.server)
      .post(`/v19.0/${phone}/messages/uno-message-1/recover_delivery`)
      .send({
        to: '5566996810064',
        type: 'text',
        text: { body: 'reenviar agora' },
      })

    expect(res.status).toEqual(200)
    expect(recoverSpy).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        message_id: 'uno-message-1',
        to: '5566996810064',
        type: 'text',
        _requestId: expect.any(String),
      }),
      expect.objectContaining({
        endpoint: 'messages',
        forceDeliveryRecovery: true,
        forceSessionRefresh: true,
        forceDeviceList: true,
        useUserDevicesCache: false,
      }),
    )
  })

  test('whatsapp with 400 status', async () => {
    jest.spyOn(incoming, 'send').mockRejectedValue(new Error('cannot login'))
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send(json)
    expect(res.status).toEqual(400)
  })

  test('whatsapp with error', async () => {
    const response: Response = {
      error: { code: 1, title: 'humm' },
      ok: { o: 'skjdh' },
    }
    const p: Promise<Response> = new Promise((resolve) => resolve(response))
    jest.spyOn(incoming, 'send').mockReturnValue(p)
    const sendSpy = jest.spyOn(outgoing, 'send')
    const res = await request(app.server).post(`/v15.0/${phone}/messages`).send(json)
    expect(sendSpy).toHaveBeenCalledWith(phone, response.error)
    expect(res.status).toEqual(200)
  })
})
