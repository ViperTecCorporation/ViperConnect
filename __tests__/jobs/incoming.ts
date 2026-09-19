jest.mock('../../src/amqp', () => ({
  amqpPublish: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../src/services/reply_warning_outbox', () => ({
  ...jest.requireActual('../../src/services/reply_warning_outbox'),
  loadReplyWarning: jest.fn(async () => undefined), completeReplyWarning: jest.fn(async () => undefined),
}))

import { mock } from 'jest-mock-extended'

import { IncomingJob } from '../../src/jobs/incoming'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import { SendError } from '../../src/services/send_error'
import { UNOAPI_MEDIA_PUBLIC_URL, UNOAPI_MEDIA_SOURCE, UNOAPI_MEDIA_STORAGE_KEY } from '../../src/services/messages/outgoing_media_input'

describe('incoming job', () => {
  test.each([undefined, 'delivered', 'read'])('delivers warnings in the status webhook without regressing %s', async previous => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadStatus.mockResolvedValue(previous as any)
    const warnings = [{ code: 'REPLY_SENT_WITHOUT_QUOTE', message: 'Mensagem enviada sem citação.' }]
    incoming.send.mockResolvedValue({ ok: { messages: [{ id: 'uno-warning' }], warnings } })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig, provider: 'zapo', server: 'server_1', outgoingIdempotency: false,
      webhooks: [{ ...defaultConfig.webhooks[0], sendUpdateMessages: true }],
      getStore: async () => ({ dataStore }) as any,
    }))
    await job.consume('5511000000000', { id: 'uno-warning', payload: { to: '5511222222222', type: 'text', text: { body: 'Resposta' } } })
    const status = (outgoing.sendHttp as jest.Mock).mock.calls.map(call => call[2]?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]).find(s => s?.warnings)
    expect(status).toEqual(expect.objectContaining({ id: 'uno-warning', status: previous || 'sent', warnings }))
    expect(incoming.send).toHaveBeenCalledTimes(1)
  })
  test('reuses staged Base64 media and keeps internal metadata out of outgoing webhooks', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('provider-image-id')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'provider-image-id' }] },
    })
    const mediaStore = {} as any
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{ ...defaultConfig.webhooks[0], sendNewMessages: true }],
      getStore: async () => ({ dataStore, mediaStore }) as any,
    }))

    await job.consume('5566999999999', {
      id: 'uno-base64-image',
      payload: {
        to: '5511999999999',
        type: 'image',
        image: {
          link: '/data/medias/5566999999999/uno-base64-image.jpeg',
          mime_type: 'image/jpeg',
          filename: 'foto.jpg',
          [UNOAPI_MEDIA_STORAGE_KEY]: '5566999999999/uno-base64-image.jpeg',
          [UNOAPI_MEDIA_SOURCE]: 'base64',
          [UNOAPI_MEDIA_PUBLIC_URL]: 'https://uno.test/v15.0/download/5566999999999/uno-base64-image.jpeg',
        },
      },
    })

    expect(dataStore.setMediaPayload).toHaveBeenCalledWith('uno-base64-image', expect.objectContaining({
      id: '5566999999999/uno-base64-image',
      mime_type: 'image/jpeg',
      url: 'https://uno.test/v15.0/download/5566999999999/uno-base64-image.jpeg',
    }))
    const webhookPayload = (outgoing.sendHttp as jest.Mock).mock.calls
      .map((call) => call[2])
      .find((payload) => payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0])
    const image = webhookPayload.entry[0].changes[0].value.messages[0].image
    expect(image).not.toHaveProperty('base64')
    expect(image).not.toHaveProperty(UNOAPI_MEDIA_STORAGE_KEY)
    expect(image).not.toHaveProperty(UNOAPI_MEDIA_SOURCE)
    expect(image).not.toHaveProperty(UNOAPI_MEDIA_PUBLIC_URL)
    expect(image.url).toBe('https://uno.test/v15.0/download/5566999999999/uno-base64-image.jpeg')
  })

  test.each([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'sticker',
    'contacts',
    'interactive',
    'poll',
    'poll_vote',
    'poll-vote',
    'message_edit',
    'reaction',
    'template',
    'baileys',
  ])('emits a failed webhook when Zapo rejects a %s action', async (type) => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    incoming.send = jest.fn().mockRejectedValue(new SendError(400, `zapo_${type}_failed`))
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          sendUpdateMessages: true,
        },
      ],
    }))

    await job.consume(
      '5566999999999',
      {
        id: `uno-${type}-failed`,
        payload: {
          to: '5511999999999',
          type,
          [type]: {},
        },
        options: { endpoint: 'messages' },
      },
      { countRetries: 1, maxRetries: 5 },
    )

    const status = (outgoing.sendHttp as jest.Mock).mock.calls[0][2].entry[0].changes[0].value.statuses[0]
    expect(status).toEqual(
      expect.objectContaining({
        id: `uno-${type}-failed`,
        recipient_id: '5511999999999',
        status: 'failed',
        errors: [
          expect.objectContaining({
            code: 400,
            title: 'Não foi possível enviar a mensagem pelo WhatsApp.',
            error_data: expect.objectContaining({
              reason: `zapo_${type}_failed`,
              provider: 'zapo',
              message_type: type,
            }),
          }),
        ],
      }),
    )
  })

  test('retries a native Zapo error before emitting its failed webhook', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const error = new Error('socket temporarily unavailable')
    incoming.send = jest.fn().mockRejectedValue(error)
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{ ...defaultConfig.webhooks[0] }],
    }))
    const data = {
      id: 'uno-native-error',
      payload: { to: '5511999999999', type: 'text', text: { body: 'Oi' } },
    }

    await expect(job.consume('5566999999999', data, { countRetries: 1, maxRetries: 5 })).rejects.toThrow('socket temporarily unavailable')
    expect(outgoing.sendHttp).not.toHaveBeenCalled()

    await expect(job.consume('5566999999999', data, { countRetries: 5, maxRetries: 5 })).resolves.toEqual(
      expect.objectContaining({
        error: expect.any(Object),
      }),
    )
    expect(outgoing.sendHttp).toHaveBeenCalledWith(
      '5566999999999',
      expect.any(Object),
      expect.objectContaining({ object: 'whatsapp_business_account' }),
      expect.objectContaining({ priority: 1 }),
    )
  })

  test('requeues a Zapo send while the client is reconnecting', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    incoming.send = jest.fn().mockRejectedValue(new SendError(409, 'zapo_client_not_connected'))
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{ ...defaultConfig.webhooks[0] }],
    }))
    const data = {
      id: 'uno-worker-restart',
      payload: { to: '5511999999999', type: 'text', text: { body: 'Persistir no restart' } },
    }

    await expect(job.consume('5566999999999', data, { countRetries: 1, maxRetries: 5 }))
      .rejects.toThrow('zapo_client_not_connected')
    expect(outgoing.sendHttp).not.toHaveBeenCalled()
  })

  test('preserves the original message id when a Zapo status action fails', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    incoming.send = jest.fn().mockRejectedValue(new SendError(404, 'message_not_found'))
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{ ...defaultConfig.webhooks[0] }],
    }))

    await job.consume(
      '5566999999999',
      {
        payload: {
          message_id: 'uno-original-message',
          status: 'read',
        },
      },
      { countRetries: 1, maxRetries: 5 },
    )

    const status = (outgoing.sendHttp as jest.Mock).mock.calls[0][2].entry[0].changes[0].value.statuses[0]
    expect(status).toEqual(
      expect.objectContaining({
        id: 'uno-original-message',
        recipient_id: '5566999999999',
        status: 'failed',
        errors: [
          expect.objectContaining({
            error_data: expect.objectContaining({
              message_type: 'status_read',
            }),
          }),
        ],
      }),
    )
  })

  test('does not block a delete status because the original message key already exists', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadKey.mockResolvedValue({
      remoteJid: '5511999999999@lid',
      id: 'provider-message-id',
      fromMe: true,
    })
    dataStore.loadStatus.mockResolvedValue('delivered')
    incoming.send = jest.fn().mockResolvedValue({ ok: { success: true } })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: true,
      webhooks: [],
      getStore: async () => ({ dataStore }) as any,
    }))
    const payload = {
      status: 'deleted',
      message_id: 'uno-original-message',
      recipient_id: '5511999999999',
    }

    await job.consume('5566999999999', { payload })

    expect(incoming.send).toHaveBeenCalledWith(
      '5566999999999',
      payload,
      expect.objectContaining({ unoMessageId: 'uno-original-message' }),
    )
    expect(dataStore.loadKey).not.toHaveBeenCalled()
  })

  test('keeps idempotency protection for a duplicated new message send', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadKey.mockResolvedValue({
      remoteJid: '5511999999999@lid',
      id: 'provider-message-id',
      fromMe: true,
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: true,
      webhooks: [],
      getStore: async () => ({ dataStore }) as any,
    }))

    await expect(job.consume('5566999999999', {
      id: 'uno-duplicate-message',
      payload: { to: '5511999999999', type: 'text', text: { body: 'Oi' } },
    })).resolves.toEqual({ ok: { success: true, idempotent: true } })

    expect(incoming.send).not.toHaveBeenCalled()
  })

  test('keeps the queue Uno id associated directly with the real provider id', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0ZAPO')
    dataStore.setUnoId.mockResolvedValue('uno-request-1')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-request-1' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [],
      getStore: async () => ({ dataStore }) as any,
    }))

    await job.consume('5566999999999', {
      id: 'uno-request-1',
      payload: { to: '5511999999999', type: 'text', text: { body: 'Oi' } },
      options: { endpoint: 'messages' },
    })

    expect(incoming.send).toHaveBeenCalledWith('5566999999999', expect.any(Object), expect.objectContaining({ unoMessageId: 'uno-request-1' }))
    expect(dataStore.setUnoId).toHaveBeenCalledWith('3EB0ZAPO', 'uno-request-1')
    expect(dataStore.setUnoId).not.toHaveBeenCalledWith('uno-request-1', 'uno-request-1')
  })

  test('emits a Chatwoot-compatible outgoing message echo', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0ZAPO')
    dataStore.setUnoId.mockResolvedValue('uno-request-chatwoot')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-request-chatwoot' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          sendNewMessages: true,
          url: '',
          urlAbsolute: 'https://chatwoot.example.com/webhooks/whatsapp/5566999554300',
        },
      ],
      getStore: async () => ({ dataStore }) as any,
    }))

    await job.consume('5566999554300', {
      id: 'uno-request-chatwoot',
      payload: {
        to: '5549991851558',
        type: 'text',
        text: { body: 'Mensagem do Chatwoot' },
      },
      options: { endpoint: 'messages' },
    })

    const payloads = (outgoing.sendHttp as jest.Mock).mock.calls.map((call) => call[2])
    const echo = payloads.find((webhook) => webhook?.entry?.[0]?.changes?.[0]?.field === 'smb_message_echoes')
    expect(echo.entry[0].changes[0].value.message_echoes[0]).toEqual(expect.objectContaining({
      from: '5566999554300',
      to: '5549991851558',
      id: 'uno-request-chatwoot',
      type: 'text',
      text: { body: 'Mensagem do Chatwoot' },
    }))
    expect(payloads.some((webhook) => webhook?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.status === 'sent')).toBe(true)
  })

  test.each(['5511999999999', '120363123456789@g.us'])(
    'emits complete edit contracts for Chatwoot and generic webhooks to %s', async to => {
      const incoming = mock<Incoming>()
      const outgoing = mock<Outgoing>()
      const dataStore = mock<DataStore>()
      dataStore.loadProviderId.mockResolvedValue('provider-edit')
      dataStore.setUnoId.mockResolvedValue('uno-edit-event')
      incoming.send = jest.fn().mockResolvedValue({
        ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-edit-event' }] },
      })
      const job = new IncomingJob(incoming, outgoing, async () => ({
        ...defaultConfig, provider: 'zapo', server: 'server_1', outgoingIdempotency: false,
        webhooks: ['https://chatwoot.example.com/webhooks/whatsapp/5511888888888', 'https://example.com/hook']
          .map(urlAbsolute => ({ ...defaultConfig.webhooks[0], sendNewMessages: true, url: '', urlAbsolute })),
        getStore: async () => ({ dataStore }) as any,
      }))
      const payload = { to, type: 'message_edit', context: { message_id: 'uno-original' },
        text: { body: 'ou vale a pena incorporar um smtp no painel pra disparar alerta' } }
      const before = JSON.stringify(payload)
      await job.consume('5511888888888', { id: 'uno-edit-event', payload, options: { endpoint: 'messages' } })
      expect(incoming.send).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(payload)).toBe(before)
      const values = (outgoing.sendHttp as jest.Mock).mock.calls
        .map(call => JSON.parse(JSON.stringify(call[2])).entry[0].changes[0].value)
        .filter(value => value.messages || value.message_echoes)
      expect(values).toHaveLength(2)
      for (const value of values) {
        const message = (value.message_echoes || value.messages)[0]
        expect(message).toEqual(expect.objectContaining({
          id: 'uno-edit-event', type: 'text', text: payload.text, message_type: 'message_edit',
          context: { id: 'uno-original', message_id: 'uno-original' },
          edit_timestamp: Number(message.timestamp) * 1000,
        }))
        expect(message).not.toHaveProperty('message_edit')
        if (to.endsWith('@g.us') && value.messages) expect(message.group_id).toBe(to)
        if (value.message_echoes) expect(message.to).toBe(to)
      }
    },
  )

  test('renders a PIX key as text in the Chatwoot outgoing echo', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0PIX')
    dataStore.setUnoId.mockResolvedValue('uno-pix-echo')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-pix-echo' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{
        ...defaultConfig.webhooks[0],
        sendNewMessages: true,
        url: '',
        urlAbsolute: 'https://chatwoot.example.com/webhooks/whatsapp/5566999554300',
      }],
      getStore: async () => ({ dataStore }) as any,
    }))

    await job.consume('5566999554300', {
      id: 'uno-pix-echo',
      payload: {
        to: '5549991851558',
        type: 'interactive',
        interactive: {
          type: 'button',
          action: {
            buttons: [{
              type: 'payment_request',
              payment_setting: {
                type: 'pix_static_code',
                pix_static_code: {
                  merchant_name: 'Viper Tec',
                  key_type: 'EMAIL',
                  key: 'financeiro@vipertec.com.br',
                },
              },
            }],
          },
        },
      },
      options: { endpoint: 'messages' },
    })

    const echo = (outgoing.sendHttp as jest.Mock).mock.calls
      .map((call) => call[2])
      .find((webhook) => webhook?.entry?.[0]?.changes?.[0]?.field === 'smb_message_echoes')
    expect(echo.entry[0].changes[0].value.message_echoes[0]).toEqual(expect.objectContaining({
      type: 'text',
      text: { body: '*Viper Tec*\nChave PIX tipo *EMAIL*: financeiro@vipertec.com.br' },
    }))
  })

  test('preserves complete order_details in the Chatwoot outgoing echo', async () => {
    const pixCode = '00020101021226940014BR.GOV.BCB.PIX2572qrcodespix.sejaefi.com.br/bolix/v2/cobv/663b44b6c993415e9e09f92c106d48865204000053039865802BR5905EFISA6008SAOPAULO62070503***63047595'
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0ORDER')
    dataStore.setUnoId.mockResolvedValue('uno-order-echo')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-order-echo' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          sendNewMessages: true,
          url: '',
          urlAbsolute: 'https://chatwoot.example.com/webhooks/whatsapp/5566999554300',
        },
        {
          ...defaultConfig.webhooks[0],
          id: 'consumer',
          sendNewMessages: true,
          url: '',
          urlAbsolute: 'https://consumer.example.com/whatsapp',
        },
      ],
      getStore: async () => ({ dataStore }) as any,
    }))
    const parameters = {
      reference_id: 'order-123',
      type: 'physical-goods',
      payment_type: 'br',
      payment_settings: [
        { type: 'boleto', boleto: { digitable_line: '1234567890' } },
        {
          type: 'pix_dynamic_code',
          pix_dynamic_code: {
            code: pixCode,
            merchant_name: 'Merchant',
            key: 'pix-key',
            key_type: 'EVP',
          },
        },
      ],
      currency: 'BRL',
      total_amount: { value: 6000, offset: 100 },
      order: {
        status: 'pending',
        items: [{ name: 'Camera', amount: { value: 6000, offset: 100 }, quantity: 1 }],
        subtotal: { value: 6000, offset: 100 },
        tax: { value: 0, offset: 100 },
      },
    }
    const interactive = {
      type: 'order_details',
      header: { type: 'image', image: { link: 'https://example.test/order.jpg' } },
      body: { text: 'Revise seu pedido' },
      footer: { text: 'Merchant' },
      action: { name: 'review_and_pay', parameters },
    }

    await job.consume('5566999554300', {
      id: 'uno-order-echo',
      payload: {
        to: '5566996269251',
        type: 'interactive',
        interactive,
      },
      options: { endpoint: 'messages' },
    })

    const echo = (outgoing.sendHttp as jest.Mock).mock.calls
      .map((call) => call[2])
      .find((webhook) => webhook?.entry?.[0]?.changes?.[0]?.field === 'smb_message_echoes')
    const expectedInteractive = {
      ...interactive,
      action: {
        ...interactive.action,
        buttons: [{
          type: 'cta_copy',
          copy_code: { title: 'Copiar código PIX', code: pixCode },
        }],
      },
    }
    expect(echo.entry[0].changes[0].value.message_echoes[0]).toEqual(expect.objectContaining({
      from: '5566999554300',
      to: '5566996269251',
      id: 'uno-order-echo',
      type: 'interactive',
      interactive: expectedInteractive,
    }))
    expect(echo.entry[0].changes[0].value.message_echoes[0]).not.toHaveProperty('text')
    const standard = (outgoing.sendHttp as jest.Mock).mock.calls
      .map((call) => call[2])
      .find((webhook) => webhook?.entry?.[0]?.changes?.[0]?.field === 'messages')
    expect(standard.entry[0].changes[0].value.messages[0].interactive)
      .toEqual(expectedInteractive)
  })

  test.each([
    ['button', {
      type: 'button',
      body: { text: 'Escolha uma opção' },
      action: {
        buttons: [{
          type: 'reply',
          reply: { id: 'confirmar', title: 'Confirmar' },
        }],
      },
    }],
    ['list', {
      type: 'list',
      body: { text: 'Escolha um item' },
      action: {
        button: 'Abrir lista',
        sections: [{
          title: 'Opções',
          rows: [{ id: 'item-1', title: 'Item 1' }],
        }],
      },
    }],
    ['carousel', {
      type: 'carousel',
      body: { text: 'Conheça nossos planos' },
      action: {
        carousel: {
          cards: [
            { body: { text: 'Plano Básico' } },
            { body: { text: 'Plano Profissional' } },
          ],
        },
      },
    }],
    ['order_status', {
      type: 'order_status',
      body: { text: 'Seu pedido foi atualizado' },
      action: {
        name: 'review_order',
        parameters: {
          reference_id: 'pedido-123',
          payment: { status: 'paid' },
        },
      },
    }],
  ])('emits a Chatwoot-compatible outgoing echo for %s interactive messages', async (_name, interactive) => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0INTERACTIVE')
    dataStore.setUnoId.mockResolvedValue('uno-interactive-echo')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-interactive-echo' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{
        ...defaultConfig.webhooks[0],
        sendNewMessages: true,
        url: '',
        urlAbsolute: 'https://chatwoot.example.com/webhooks/whatsapp/5566999554300',
      }],
      getStore: async () => ({ dataStore }) as any,
    }))

    await job.consume('5566999554300', {
      id: 'uno-interactive-echo',
      payload: {
        to: '5549991851558',
        type: 'interactive',
        interactive,
      },
      options: { endpoint: 'messages' },
    })

    const echo = (outgoing.sendHttp as jest.Mock).mock.calls
      .map((call) => call[2])
      .find((webhook) => webhook?.entry?.[0]?.changes?.[0]?.field === 'smb_message_echoes')
    expect(echo.entry[0].changes[0].value.message_echoes[0]).toEqual(expect.objectContaining({
      from: '5566999554300',
      to: '5549991851558',
      id: 'uno-interactive-echo',
      type: 'interactive',
      interactive,
    }))
  })

  test('normalizes carousel CTA URL in the Chatwoot echo without changing generic webhooks', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0CAROUSEL')
    dataStore.setUnoId.mockResolvedValue('uno-carousel-echo')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-carousel-echo' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          sendNewMessages: true,
          url: '',
          urlAbsolute: 'https://chatwoot.example.com/webhooks/whatsapp/5566999554300',
        },
        {
          ...defaultConfig.webhooks[0],
          id: 'consumer',
          sendNewMessages: true,
          url: '',
          urlAbsolute: 'https://consumer.example.com/whatsapp',
        },
      ],
      getStore: async () => ({ dataStore }) as any,
    }))
    const interactive = {
      type: 'carousel',
      action: {
        carousel: {
          cards: [{
            body: { text: 'Plano Profissional' },
            action: {
              buttons: [{
                type: 'cta_url',
                text: 'Agende uma demonstração',
                url: 'https://vipertec.com.br',
              }],
            },
          }],
        },
      },
    }

    await job.consume('5566996269251', {
      id: 'uno-carousel-echo',
      payload: {
        to: '5566999554300',
        type: 'interactive',
        interactive,
      },
      options: { endpoint: 'messages' },
    })

    const calls = (outgoing.sendHttp as jest.Mock).mock.calls
    const echo = calls.find((call) => call[1].urlAbsolute.includes('chatwoot'))[2]
    const standard = calls.find((call) => call[1].urlAbsolute.includes('consumer'))[2]
    expect(echo.entry[0].changes[0].value.message_echoes[0]
      .interactive.action.carousel.cards[0].action.buttons[0]).toEqual(expect.objectContaining({
      type: 'cta_url',
      url: {
        title: 'Agende uma demonstração',
        link: 'https://vipertec.com.br',
      },
    }))
    expect(standard.entry[0].changes[0].value.messages[0]
      .interactive.action.carousel.cards[0].action.buttons[0].url).toBe('https://vipertec.com.br')
  })

  test('dispatches provider contact operations without going through message sending', async () => {
    const incoming = mock<Incoming>()
    incoming.contacts = jest.fn().mockResolvedValue([{ input: '5566', status: 'valid' }])
    const job = new IncomingJob(incoming, mock<Outgoing>(), async () => ({ ...defaultConfig, server: 'server_1' }))

    await expect(
      job.consume('556600000000', {
        type: 'provider_operation',
        action: 'contacts',
        args: [['5566']],
      }),
    ).resolves.toEqual([{ input: '5566', status: 'valid' }])
    expect(incoming.contacts).toHaveBeenCalledWith('556600000000', ['5566'])
    expect(incoming.send).not.toHaveBeenCalled()
  })

  test('dispatches address-book contact creation to the local client adapter', async () => {
    const incoming = mock<Incoming>()
    const input = { phone_number: '5511988887777', full_name: 'Maria Silva' }
    incoming.saveContact = jest.fn().mockResolvedValue({
      success: true,
      contact: { ...input, first_name: 'Maria', user_id: '123@lid' },
    })
    const job = new IncomingJob(incoming, mock<Outgoing>(), async () => ({ ...defaultConfig, server: 'server_1' }))

    await expect(job.consume('556600000000', {
      type: 'provider_operation',
      action: 'saveContact',
      args: [input],
    })).resolves.toEqual(expect.objectContaining({ success: true }))

    expect(incoming.saveContact).toHaveBeenCalledWith('556600000000', input)
  })

  test('dispatches pairing-code requests to the local client adapter', async () => {
    const incoming = mock<Incoming>()
    incoming.requestPairingCode = jest.fn().mockResolvedValue('1234-5678')
    const job = new IncomingJob(incoming, mock<Outgoing>(), async () => ({ ...defaultConfig, server: 'server_1' }))
    await expect(
      job.consume('5566', {
        type: 'provider_operation',
        action: 'requestPairingCode',
        args: [],
      }),
    ).resolves.toBe('1234-5678')
  })

  test('dispatches group management RPC payloads to the local incoming provider', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
    })
    incoming.groupParticipantsUpdate = jest.fn().mockResolvedValue([{ jid: '556699999999@s.whatsapp.net', status: '200' }])
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await expect(
      job.consume('556600000000', {
        type: 'group_management',
        action: 'groupParticipantsUpdate',
        args: ['120363040468224422@g.us', ['556699999999@s.whatsapp.net'], 'remove'],
      }),
    ).resolves.toEqual([{ jid: '556699999999@s.whatsapp.net', status: '200' }])

    expect(incoming.groupParticipantsUpdate).toHaveBeenCalledWith(
      '556600000000',
      '120363040468224422@g.us',
      ['556699999999@s.whatsapp.net'],
      'remove',
    )
  })

  test('dispatches group profile picture lookups to the local provider', async () => {
    const incoming = mock<Incoming>()
    const job = new IncomingJob(incoming, mock<Outgoing>(), async () => ({ ...defaultConfig, server: 'server_1' }))
    incoming.groupProfilePicture = jest.fn().mockResolvedValue({
      url: 'https://cdn.example/group.jpg',
    })

    await expect(
      job.consume('556600000000', {
        type: 'group_management',
        action: 'groupProfilePicture',
        args: ['120363040468224422@g.us', false],
      }),
    ).resolves.toEqual({
      url: 'https://cdn.example/group.jpg',
    })
    expect(incoming.groupProfilePicture).toHaveBeenCalledWith('556600000000', '120363040468224422@g.us', false)
  })

  test('rejects unknown group management action', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
    })
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await expect(
      job.consume('556600000000', {
        type: 'group_management',
        action: 'groupDestroyEverything',
        args: [],
      }),
    ).rejects.toThrow('Unknown group management action groupDestroyEverything')
  })

  test('returns empty group invite code when provider reports not authorized', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
    })
    const error = new Error('not-authorized') as any
    error.data = 401
    incoming.groupInviteCode = jest.fn().mockRejectedValue(error)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await expect(
      job.consume('556600000000', {
        type: 'group_management',
        action: 'groupInviteCode',
        args: ['120363040468224422@g.us'],
      }),
    ).resolves.toBeUndefined()

    expect(incoming.groupInviteCode).toHaveBeenCalledWith('556600000000', '120363040468224422@g.us')
  })

  test('emits meta-like group webhook when provider success has no message id', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendGroupMessages: true,
        },
      ],
    })
    incoming.send = jest.fn().mockResolvedValue({ ok: { success: true } })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('5566996269251', {
      id: 'uno-id-1',
      payload: {
        messaging_product: 'whatsapp',
        to: '120363039221813429@g.us',
        type: 'text',
        text: { body: 'Teste' },
      },
      options: {},
    })

    expect(outgoing.sendHttp).toHaveBeenCalled()
    const webhookPayload = (outgoing.sendHttp as jest.Mock).mock.calls[0][2]
    const value = webhookPayload.entry[0].changes[0].value

    expect(value.contacts[0]).toEqual({
      wa_id: '5566996269251',
      group_id: '120363039221813429@g.us',
      profile: {
        name: '5566996269251',
      },
    })
    expect(value.contacts[0].profile.picture).toBeUndefined()
    expect(value.contacts[0].group_picture).toBeUndefined()
    expect(value.messages[0]).toEqual({
      from: '5566996269251',
      id: 'uno-id-1',
      timestamp: expect.any(String),
      text: { body: 'Teste' },
      type: 'text',
      group_id: '120363039221813429@g.us',
    })
  })

  test('omits empty group and profile pictures in outgoing group webhook', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendGroupMessages: true,
        },
      ],
    })
    incoming.send = jest.fn().mockResolvedValue({ ok: { success: true } })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('5566996269251', {
      id: 'uno-id-2',
      payload: {
        messaging_product: 'whatsapp',
        to: '120363039221813429@g.us',
        type: 'text',
        text: { body: 'Teste' },
        group_subject: 'Grupo sem foto',
        group_picture: '',
        profile: {
          name: 'Participante sem foto',
          picture: '',
        },
      },
      options: {},
    })

    const webhookPayload = (outgoing.sendHttp as jest.Mock).mock.calls[0][2]
    const contact = webhookPayload.entry[0].changes[0].value.contacts[0]

    expect(contact).toEqual({
      wa_id: '5566996269251',
      group_id: '120363039221813429@g.us',
      group_subject: 'Grupo sem foto',
      profile: {
        name: 'Participante sem foto',
      },
    })
    expect(contact.profile.picture).toBeUndefined()
    expect(contact.group_picture).toBeUndefined()
  })

  test('preserves legacy picture and adds a stable picture_id to outgoing webhooks', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [{
        ...defaultConfig.webhooks[0],
        id: 'default',
        sendNewMessages: true,
      }],
    })
    incoming.send = jest.fn().mockResolvedValue({ ok: { success: true } })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('5566996269251', {
      id: 'uno-profile-id',
      payload: {
        messaging_product: 'whatsapp',
        to: '5566999069708',
        user_id: '53515477086263@lid',
        type: 'text',
        text: { body: 'Teste' },
        profile: {
          name: 'Maria',
          picture: 'https://storage.test/avatar?X-Amz-Signature=legacy',
          picture_metadata: { etag: '"avatar"' },
        },
      },
      options: {},
    })

    const webhookPayload = (outgoing.sendHttp as jest.Mock).mock.calls[0][2]
    const profile = webhookPayload.entry[0].changes[0].value.contacts[0].profile
    expect(profile.picture).toContain('X-Amz-Signature=legacy')
    expect(profile.picture_id).toBe('53515477086263@lid')
    expect(profile.picture_metadata).toEqual({ etag: '"avatar"' })
  })

  test('emits restriction notice webhooks for 463 reachout lock without changing failed status', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = {
      loadKey: jest.fn().mockResolvedValue(undefined),
      loadStatus: jest.fn().mockResolvedValue(undefined),
      setUnoId: jest.fn().mockResolvedValue(undefined),
      setKey: jest.fn().mockResolvedValue(undefined),
      setStatus: jest.fn().mockResolvedValue(undefined),
    }
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendUpdateMessages: true,
        },
      ],
      getStore: async () => ({ dataStore }) as any,
    })
    const failedStatus = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '558134395259',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '558134395259',
                  phone_number_id: '558134395259',
                },
                statuses: [
                  {
                    id: 'provider-id-1',
                    recipient_id: '5581981829525',
                    status: 'failed',
                    timestamp: 1783022808,
                    errors: [
                      {
                        code: 463,
                        title: 'Account restricted for companion or missing tctoken',
                        message: 'Your account has been restricted',
                        error_data: {
                          reason: 'message_account_restriction',
                          from: '558181829525@s.whatsapp.net',
                          msgId: 'provider-id-1',
                          reachout: {
                            isActive: true,
                            timeEnforcementEnds: '2026-07-09T17:28:30.000Z',
                            enforcementType: 'RESTRICT_ALL_COMPANIONS',
                          },
                        },
                      },
                    ],
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    incoming.send = jest.fn().mockResolvedValue({
      ok: {
        messaging_product: 'whatsapp',
        contacts: [{ wa_id: '5581981829525' }],
        messages: [{ id: 'provider-id-1' }],
      },
      error: failedStatus,
    })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('558134395259', {
      id: 'uno-id-463',
      payload: {
        messaging_product: 'whatsapp',
        to: '5581981829525',
        type: 'text',
        text: { body: 'Primeira mensagem' },
      },
      options: {},
    })

    const calls = (outgoing.sendHttp as jest.Mock).mock.calls
    const statusPayload = calls.find((call) => call[2]?.entry?.[0]?.changes?.[0]?.value?.statuses)?.[2]
    const noticePayloads = calls
      .map((call) => call[2])
      .filter((payload) => payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.includes('Codigo 463'))

    expect(statusPayload.entry[0].changes[0].value.statuses[0].id).toBe('uno-id-463')
    expect(noticePayloads).toHaveLength(2)
    expect(noticePayloads[0].entry[0].changes[0].value.contacts[0].wa_id).toBe('5581981829525')
    expect(noticePayloads[1].entry[0].changes[0].value.contacts[0].wa_id).toBe('558134395259')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Restricao ativa ate: 09/07/2026, 14:28:30 BRT')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Mensagem: uno-id-463')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Conteudo original: Primeira mensagem')
  })

  test('emits restriction notice webhooks for 463 even without ok message id', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = {
      loadStatus: jest.fn().mockResolvedValue(undefined),
      setStatus: jest.fn().mockResolvedValue(undefined),
    }
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendUpdateMessages: true,
        },
      ],
      getStore: async () => ({ dataStore }) as any,
    })
    const failedStatus = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '558134395259',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '558134395259',
                  phone_number_id: '558134395259',
                },
                statuses: [
                  {
                    id: 'provider-id-2',
                    recipient_id: '5581981829525',
                    status: 'failed',
                    timestamp: 1783022808,
                    errors: [
                      {
                        code: 463,
                        title: 'Account restricted for companion or missing tctoken',
                        message: 'Your account has been restricted',
                        error_data: {
                          reason: 'message_account_restriction',
                          from: '558181829525@s.whatsapp.net',
                          msgId: 'provider-id-2',
                          reachout: {
                            isActive: true,
                            timeEnforcementEnds: '2026-07-09T17:28:30.000Z',
                            enforcementType: 'RESTRICT_ALL_COMPANIONS',
                          },
                        },
                      },
                    ],
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    incoming.send = jest.fn().mockResolvedValue({
      ok: { success: false },
      error: failedStatus,
    })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('558134395259', {
      id: 'uno-id-463-no-ok',
      payload: {
        messaging_product: 'whatsapp',
        to: '5581981829525',
        type: 'text',
        text: { body: 'Primeira mensagem' },
      },
      options: {},
    })

    const calls = (outgoing.sendHttp as jest.Mock).mock.calls
    const statusPayload = calls.find((call) => call[2]?.entry?.[0]?.changes?.[0]?.value?.statuses)?.[2]
    const noticePayloads = calls
      .map((call) => call[2])
      .filter((payload) => payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.includes('Codigo 463'))

    expect(statusPayload.entry[0].changes[0].value.statuses[0].id).toBe('uno-id-463-no-ok')
    expect(noticePayloads).toHaveLength(2)
    expect(noticePayloads[0].entry[0].changes[0].value.contacts[0].wa_id).toBe('5581981829525')
    expect(noticePayloads[1].entry[0].changes[0].value.contacts[0].wa_id).toBe('558134395259')
  })
})
