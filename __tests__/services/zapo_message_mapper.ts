jest.mock('node-fetch', () => jest.fn())
jest.mock('../../src/services/zapo/zapo_media_processor', () => ({
  zapoMediaProcessor: {
    generateImageThumbnail: jest.fn(),
  },
}))
jest.mock('../../src/services/zapo/zapo_legacy_pdf', () => ({
  zapoLegacyPdfNormalizer: {
    normalizeForWhatsApp: jest.fn(async (input) => input),
  },
}))

import { toZapoMessageContent } from '../../src/services/zapo/zapo_message_mapper'
import { zapoMediaProcessor } from '../../src/services/zapo/zapo_media_processor'
import { zapoLegacyPdfNormalizer } from '../../src/services/zapo/zapo_legacy_pdf'
import { mockDeep } from 'jest-mock-extended'
import { proto } from 'zapo-js'
import type { WaClient } from 'zapo-js'
import fetch from 'node-fetch'

describe('Zapo message mapper', () => {
  test.each(['image', 'video', 'audio'])('maps %s view_once to SDK send options, not media content', async type => {
    for (const view_once of [true, false, undefined]) {
      const mapped = await toZapoMessageContent(mockDeep<WaClient>(), {
        type, [type]: { link: '/test/media', view_once }, mentions: ['5511999999999'],
      })
      expect(mapped.options).toEqual({ mentions: ['5511999999999@s.whatsapp.net'], ...(view_once === undefined ? {} : { viewOnce: view_once }) })
      expect(mapped.content).not.toHaveProperty('viewOnce')
      expect(mapped.content).not.toHaveProperty('view_once')
    }
  })
  test('worker rejects invalid view_once before media download', async () => {
    await expect(toZapoMessageContent(mockDeep<WaClient>(), { type: 'image', image: { link: 'https://example.test/image.jpg', view_once: 'true' } }))
      .rejects.toThrow('view_once_must_be_boolean')
    expect(fetch).not.toHaveBeenCalled()
  })
  // Official raw-send contract: https://zapo.to/en/guides/raw-sends#contacts
  test.each([1, 2, 3])('maps %i contact cards to the single/array Zapo protobuf', async (count) => {
    const contacts = ['José Silva', 'Maria Souza', 'Ana Lima'].slice(0, count).map((name, index) => ({
      name: { formatted_name: name },
      phones: [{ phone: `+551198888777${index}`, wa_id: `551198888777${index}` }],
      emails: [{ email: `contact${index}@example.test` }],
    }))
    const mapped = await toZapoMessageContent(mockDeep<WaClient>(), { type: 'contacts', contacts })
    expect(mapped.options).toEqual({})
    expect(Object.keys(mapped.content)).toEqual([count === 1 ? 'contactMessage' : 'contactsArrayMessage'])
    const decoded = proto.Message.decode(proto.Message.encode(mapped.content as any).finish())
    const cards = count === 1 ? [decoded.contactMessage!] : decoded.contactsArrayMessage!.contacts!
    expect(cards).toHaveLength(count)
    if (count > 1) expect(decoded.contactsArrayMessage!.displayName).toBe(`${count} contacts`)
    cards.forEach((card, index) => {
      expect(card.displayName).toBe(contacts[index].name.formatted_name)
      expect(card.vcard).toContain(`FN:${contacts[index].name.formatted_name}`)
      expect(card.vcard).toMatch(new RegExp(`waid=551198888777${index}`, 'i'))
      expect(card.vcard).toContain(`contact${index}@example.test`)
    })
  })

  test('rejects empty contact lists and cards without phones', async () => {
    await expect(toZapoMessageContent(mockDeep<WaClient>(), { type: 'contacts', contacts: [] }))
      .rejects.toThrow('invalid_contacts_payload: empty list')
    await expect(toZapoMessageContent(mockDeep<WaClient>(), {
      type: 'contacts', contacts: [{ name: { formatted_name: 'José' } }],
    })).rejects.toThrow('invalid_contacts_payload: missing phones')
  })

  test('maps Cloud API static location to a serializable Zapo protobuf', async () => {
    const mapped = await toZapoMessageContent(mockDeep<WaClient>(), {
      type: 'location', location: { latitude: '-15.6', longitude: '-56.1', name: 'Praça', address: 'Cuiabá' },
    })
    expect(mapped).toEqual({ content: { locationMessage: { degreesLatitude: -15.6, degreesLongitude: -56.1, name: 'Praça', address: 'Cuiabá' } }, options: {} })
    const decoded = proto.Message.decode(proto.Message.encode(mapped.content as any).finish())
    expect(decoded.locationMessage).toMatchObject({ degreesLatitude: -15.6, degreesLongitude: -56.1, name: 'Praça', address: 'Cuiabá' })
  })

  test('worker mapper rejects invalid location even without the HTTP validator', async () => {
    await expect(toZapoMessageContent(mockDeep<WaClient>(), { type: 'location', location: { latitude: 91, longitude: 0 } })).rejects.toThrow('invalid_location_latitude')
  })
  const client = mockDeep<WaClient>()
  const mockFetch = fetch as unknown as jest.Mock
  const mockGenerateImageThumbnail = zapoMediaProcessor.generateImageThumbnail as jest.Mock
  const mockNormalizePdf = zapoLegacyPdfNormalizer.normalizeForWhatsApp as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    mockNormalizePdf.mockImplementation(async (input) => input)
    mockGenerateImageThumbnail.mockResolvedValue({
      jpegThumbnail: Uint8Array.from([9, 8, 7]),
      width: 1024,
      height: 1024,
    })
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: jest.fn().mockReturnValue('application/octet-stream') },
      arrayBuffer: jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
    })
  })

  test('maps text and mentions to the documented typed Zapo content', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'text',
      text: { body: 'Oi @556699999999' },
    }, (text) => `${text}!`)).resolves.toEqual({
      content: { type: 'text', text: 'Oi @556699999999!' },
      options: { mentions: ['556699999999@s.whatsapp.net'] },
    })
  })

  test.each([undefined, true, false])('enables link preview automatically without depending on preview_url=%s', async (previewUrl) => {
    await expect(toZapoMessageContent(client, {
      type: 'text',
      text: {
        body: 'Veja https://example.test/oferta',
        ...(previewUrl === undefined ? {} : { preview_url: previewUrl }),
      },
    })).resolves.toEqual({
      content: {
        type: 'text',
        text: 'Veja https://example.test/oferta',
        linkPreview: true,
      },
      options: {},
    })
  })

  test('does not add link preview metadata to ordinary text', async () => {
    const mapped = await toZapoMessageContent(client, {
      type: 'text',
      text: { body: 'Mensagem sem link' },
    })

    expect(mapped).toEqual({
      content: { type: 'text', text: 'Mensagem sem link' },
      options: {},
    })
    expect(mapped.content).not.toHaveProperty('linkPreview')
  })

  test('adds HTTPS to a valid bare domain before asking Zapo for the preview', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'text',
      text: { body: 'Veja vipertec.com.br/oferta' },
    })).resolves.toEqual({
      content: {
        type: 'text',
        text: 'Veja https://vipertec.com.br/oferta',
        linkPreview: true,
      },
      options: {},
    })
  })

  test('uses a resolved YouTube override without changing generic previews', async () => {
    const youtubePreview = {
      matchedText: 'https://youtube.com/shorts/L-HPPgyJ4SY?feature=share',
      title: 'Vídeo de teste',
      previewType: proto.Message.ExtendedTextMessage.PreviewType.VIDEO,
      thumbnail: { bytes: Uint8Array.from([7, 8, 9]), width: 480, height: 360 },
    }
    const resolver = jest.fn().mockResolvedValue(youtubePreview)

    await expect(toZapoMessageContent(client, {
      type: 'text',
      text: { body: 'Veja https://youtube.com/shorts/L-HPPgyJ4SY?feature=share' },
    }, undefined, resolver)).resolves.toEqual({
      content: {
        type: 'text',
        text: 'Veja https://youtube.com/shorts/L-HPPgyJ4SY?feature=share',
        linkPreview: youtubePreview,
      },
      options: {},
    })
    expect(resolver).toHaveBeenCalledWith('Veja https://youtube.com/shorts/L-HPPgyJ4SY?feature=share')
  })

  test('keeps the generic preview when the YouTube resolver fails', async () => {
    const resolver = jest.fn().mockRejectedValue(new Error('oEmbed unavailable'))
    const mapped = await toZapoMessageContent(client, {
      type: 'text',
      text: { body: 'https://youtube.com/shorts/L-HPPgyJ4SY' },
    }, undefined, resolver)

    expect(mapped.content).toEqual({
      type: 'text',
      text: 'https://youtube.com/shorts/L-HPPgyJ4SY',
      linkPreview: true,
    })
  })

  test('downloads every supported media family into bytes for the Zapo typed API', async () => {
    for (const type of ['image', 'audio', 'document', 'video', 'sticker']) {
      const mapped = await toZapoMessageContent(client, {
        type,
        [type]: { link: `https://example.test/${type}`, mime_type: 'application/octet-stream', caption: 'Legenda' },
      })
      expect(mapped.content).toEqual(expect.objectContaining({
        type,
        media: Uint8Array.from([1, 2, 3]),
        mimetype: 'application/octet-stream',
      }))
    }
    expect(mockFetch).toHaveBeenCalledTimes(5)
    expect(mockNormalizePdf).toHaveBeenCalledTimes(1)
    expect(mockNormalizePdf).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]), 'application/octet-stream')
  })

  test('uses the normalized PDF bytes for URL and internally staged Base64 documents', async () => {
    const normalized = Uint8Array.from([9, 9, 9])
    mockNormalizePdf.mockResolvedValue(normalized)

    const byUrl = await toZapoMessageContent(client, {
      type: 'document',
      document: { link: 'https://example.test/oracle.pdf', mime_type: 'application/pdf' },
    })
    const staged = await toZapoMessageContent(client, {
      type: 'document',
      document: { link: './data/medias/5566/oracle.pdf', mime_type: 'application/pdf' },
    })

    expect((byUrl.content as any).media).toBe(normalized)
    expect((staged.content as any).media).toBe(normalized)
    expect(mockNormalizePdf).toHaveBeenNthCalledWith(1, Uint8Array.from([1, 2, 3]), 'application/pdf')
    expect(mockNormalizePdf).toHaveBeenNthCalledWith(2, './data/medias/5566/oracle.pdf', 'application/pdf')
  })

  test('does not send image, video, audio or sticker media through PDF normalization', async () => {
    for (const type of ['image', 'video', 'audio', 'sticker']) {
      await toZapoMessageContent(client, {
        type,
        [type]: { link: `https://example.test/${type}`, mime_type: 'application/octet-stream' },
      })
    }
    expect(mockNormalizePdf).not.toHaveBeenCalled()
  })

  test('passes an internally staged file path to the documented Zapo media source', async () => {
    const mapped = await toZapoMessageContent(client, {
      type: 'image',
      image: { link: '/data/medias/5566/base64-image.jpeg', mime_type: 'image/jpeg' },
    })
    expect(mapped.content).toEqual(expect.objectContaining({
      type: 'image',
      media: '/data/medias/5566/base64-image.jpeg',
      mimetype: 'image/jpeg',
    }))
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('maps voice-note audio to Zapo audio content with the ptt flag', async () => {
    await expect(toZapoMessageContent(client, { type: 'audio', audio: { link: 'https://example.test/a.ogg', ptt: true } }))
      .resolves.toEqual(expect.objectContaining({ content: expect.objectContaining({ type: 'audio', ptt: true }) }))
  })

  test('rejects media without a link', async () => {
    await expect(toZapoMessageContent(client, { type: 'image', image: {} })).rejects.toThrow('invalid_image_payload')
  })

  test('passes raw protocol messages through for advanced compatibility', async () => {
    const message = { conversation: 'raw' }
    await expect(toZapoMessageContent(client, { type: 'baileys', message })).resolves.toEqual({ content: message, options: {} })
  })

  test('maps poll aliases to the documented native Zapo poll content', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'poll',
      poll: {
        question: 'Almoço?',
        options: ['Pizza', { name: 'Sushi' }],
        selectable_count: 1,
        allow_add_option: true,
      },
    })).resolves.toEqual({
      content: {
        type: 'poll',
        name: 'Almoço?',
        options: ['Pizza', 'Sushi'],
        selectableCount: 1,
        allowAddOption: true,
        hideParticipantName: false,
      },
      options: {},
    })
  })

  test('maps lists to the documented raw Zapo listMessage instead of native flow', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Cardápio' },
        body: { text: 'Escolha uma opção' },
        footer: { text: 'Atendimento' },
        action: {
          button: 'Ver opções',
          sections: [{
            title: 'Pizzas',
            rows: [{
              id: 'pizza-calabresa',
              title: 'Calabresa',
              description: 'Calabresa e cebola',
            }],
          }],
        },
      },
    })).resolves.toEqual({
      content: {
        listMessage: {
          title: 'Cardápio',
          description: 'Escolha uma opção',
          buttonText: 'Ver opções',
          footerText: 'Atendimento',
          listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
          sections: [{
            title: 'Pizzas',
            rows: [{
              rowId: 'pizza-calabresa',
              title: 'Calabresa',
              description: 'Calabresa e cebola',
            }],
          }],
        },
      },
      options: {},
    })
  })

  test('keeps buttons on the documented raw interactive native flow', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Confirma?' },
        action: {
          buttons: [{
            type: 'reply',
            reply: { id: 'confirmar', title: 'Confirmar' },
          }],
        },
      },
    })).resolves.toEqual({
      content: {
        interactiveMessage: {
          header: { title: '', hasMediaAttachment: false },
          body: { text: 'Confirma?' },
          footer: undefined,
          nativeFlowMessage: {
            buttons: [{
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: 'Confirmar',
                id: 'confirmar',
              }),
            }],
            messageVersion: 1,
          },
        },
      },
      options: {},
    })
  })

  test('normalizes a PDF used as an interactive document header before upload', async () => {
    const normalized = Uint8Array.from([7, 7, 7])
    mockNormalizePdf.mockResolvedValue(normalized)
    client.message.upload.mockResolvedValue({ url: 'uploaded' } as never)

    await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'document',
          document: { link: 'https://example.test/oracle.pdf', mime_type: 'application/pdf' },
        },
        action: { buttons: [{ type: 'reply', reply: { id: 'ok', title: 'OK' } }] },
      },
    })

    expect(mockNormalizePdf).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]), 'application/pdf')
    expect(client.message.upload).toHaveBeenCalledWith(normalized, { type: 'document', mimetype: 'application/pdf' })
  })

  test('maps a Zapo PIX payment request to the isolated payment_info native flow', async () => {
    const paymentSetting = {
      type: 'pix_static_code',
      pix_static_code: {
        merchant_name: 'Viper Tec',
        key: 'teste@vipertec.com.br',
        key_type: 'EMAIL',
      },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: [{
            type: 'payment_request',
            payment_setting: paymentSetting,
          }],
        },
      },
    })

    expect(mapped.content).not.toHaveProperty('viewOnceMessage')
    const nativeFlow = (mapped.content as any).interactiveMessage.nativeFlowMessage
    expect(nativeFlow.messageParamsJson).toEqual(expect.any(String))
    expect(nativeFlow.messageVersion).toBe(1)
    expect(nativeFlow.buttons).toHaveLength(1)
    expect(nativeFlow.buttons[0].name).toBe('payment_info')
    expect(JSON.parse(nativeFlow.buttons[0].buttonParamsJson)).toEqual(expect.objectContaining({
      currency: 'BRL',
      reference_id: expect.any(String),
      type: 'physical-goods',
      payment_settings: [paymentSetting],
      share_payment_status: false,
    }))
    expect(mapped.options).toEqual({})
  })

  test('maps a legacy standalone dynamic PIX request to the official simplified order flow', async () => {
    const paymentSetting = {
      type: 'pix_dynamic_code',
      pix_dynamic_code: {
        code: '00020101021226700014br.gov.bcb.pix.example',
        merchant_name: 'Viper Tec',
        key: '12345678000199',
        key_type: 'CNPJ',
      },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Pague R$ 149,90 via PIX' },
        action: {
          buttons: [{
            type: 'payment_request',
            payment_request: {
              type: 'digital-goods',
              payment_type: 'br',
              payment_settings: [paymentSetting],
              currency: 'BRL',
              total_amount: { value: 14990, offset: 100 },
            },
          }],
        },
      },
    })

    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    const params = JSON.parse(button.buttonParamsJson)
    expect(button.name).toBe('review_and_pay')
    expect(params).toEqual(expect.objectContaining({
      reference_id: expect.any(String),
      type: 'digital-goods',
      payment_type: 'br',
      payment_settings: [paymentSetting],
      currency: 'BRL',
      total_amount: { value: 14990, offset: 100 },
    }))
    expect(params).not.toHaveProperty('order')
  })

  test('rejects a standalone dynamic PIX without a total amount', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: [{
            type: 'payment_request',
            payment_setting: {
              type: 'pix_dynamic_code',
              pix_dynamic_code: {
                code: '00020101021226700014br.gov.bcb.pix.example',
                merchant_name: 'Viper Tec',
                key: '12345678000199',
                key_type: 'CNPJ',
              },
            },
          }],
        },
      },
    })).rejects.toThrow('pix_dynamic_code_total_amount_required')
  })

  test.each([
    ['payment link', {
      type: 'payment_link',
      payment_link: { uri: 'https://pagamentos.vipertec.com.br/cobranca-1' },
    }],
    ['boleto', {
      type: 'boleto',
      boleto: { digitable_line: '03399.02694 41400.000026 62834.610101 8 898510000008848' },
    }],
    ['one-click card', {
      type: 'offsite_card_pay',
      offsite_card_pay: { last_four_digits: '5235', credential_id: 'credential-123' },
    }],
  ])('normalizes a legacy standalone %s request to review_and_pay', async (_name, paymentSetting) => {
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Finalize o pagamento' },
        action: {
          buttons: [{
            type: 'payment_request',
            payment_request: {
              type: 'digital-goods',
              payment_type: 'br',
              payment_settings: [paymentSetting],
              currency: 'BRL',
              total_amount: { value: 14990, offset: 100 },
            },
          }],
        },
      },
    })

    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    const parameters = JSON.parse(button.buttonParamsJson)
    expect(button.name).toBe('review_and_pay')
    expect(parameters).toEqual(expect.objectContaining({
      reference_id: expect.any(String),
      type: 'digital-goods',
      payment_type: 'br',
      currency: 'BRL',
      total_amount: { value: 14990, offset: 100 },
    }))
    expect(parameters.payment_settings[0].type).toBe(paymentSetting.type)
    expect(parameters).not.toHaveProperty('order')
  })

  test.each([
    ['payment_link', { type: 'payment_link', payment_link: { uri: 'https://pagamentos.vipertec.com.br/cobranca-2' } }],
    ['boleto', { type: 'boleto', boleto: { digitable_line: '03399026944140000002628346101018898510000008848' } }],
    ['offsite_card_pay', { type: 'offsite_card_pay', offsite_card_pay: { last_four_digits: '5235', credential_id: 'credential-123' } }],
  ])('rejects a legacy %s request without the official total amount', async (paymentType, paymentSetting) => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: [{ type: 'payment_request', payment_setting: paymentSetting }],
        },
      },
    })).rejects.toThrow(`${paymentType}_total_amount_required`)
  })

  test('preserves and completes an itemized order received in the legacy envelope', async () => {
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: [{
            type: 'payment_request',
            payment_request: {
              type: 'physical-goods',
              payment_type: 'br',
              payment_settings: [{
                type: 'payment_link',
                payment_link: { uri: 'https://pagamentos.vipertec.com.br/cobranca-3' },
              }],
              currency: 'BRL',
              total_amount: { value: 5000, offset: 100 },
              order: {
                status: 'pending',
                items: [{ name: 'Produto', amount: { value: 5000, offset: 100 }, quantity: 1 }],
                subtotal: { value: 5000, offset: 100 },
              },
            },
          }],
        },
      },
    })

    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    const parameters = JSON.parse(button.buttonParamsJson)
    expect(button.name).toBe('review_and_pay')
    expect(parameters.order.items).toHaveLength(1)
    expect(parameters.order.tax).toEqual({ value: 0, offset: 100 })
  })

  test('rejects payment request variants not supported by the Zapo device protocol', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: [{
            type: 'payment_request',
            payment_setting: {
              type: 'crypto_wallet',
            },
          }],
        },
      },
    })).rejects.toThrow('zapo_payment_request_type_not_supported: crypto_wallet')
  })

  test('maps simplified order details with dynamic PIX to review_and_pay', async () => {
    const parameters = {
      reference_id: 'pedido-123',
      type: 'digital-goods',
      payment_type: 'br',
      payment_settings: [{
        type: 'pix_dynamic_code',
        pix_dynamic_code: {
          code: '00020101021226700014br.gov.bcb.pix.example',
          merchant_name: 'Viper Tec',
          key: '12345678000199',
          key_type: 'CNPJ',
        },
      }],
      currency: 'BRL',
      total_amount: { value: 50000, offset: 100 },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        body: { text: 'Revise e pague seu pedido' },
        action: { name: 'review_and_pay', parameters },
      },
    })

    const interactive = (mapped.content as any).interactiveMessage
    expect(interactive.body).toEqual({ text: 'Revise e pague seu pedido' })
    expect(interactive.nativeFlowMessage.buttons).toEqual([{
      name: 'review_and_pay',
      buttonParamsJson: JSON.stringify(parameters),
    }])
    expect(mapped.options).toEqual({})
  })

  test('preserves itemized order data in a dynamic PIX payment', async () => {
    const order = {
      status: 'pending',
      items: [{
        retailer_id: 'produto-1',
        name: 'Produto',
        amount: { value: 50000, offset: 100 },
        quantity: 1,
      }],
      subtotal: { value: 50000, offset: 100 },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-124',
            type: 'physical-goods',
            payment_type: 'br',
            payment_settings: [{
              type: 'pix_dynamic_code',
              pix_dynamic_code: {
                code: '00020101021226700014br.gov.bcb.pix.example',
                merchant_name: 'Viper Tec',
                key: 'financeiro@vipertec.com.br',
                key_type: 'EMAIL',
              },
            }],
            currency: 'BRL',
            total_amount: { value: 50000, offset: 100 },
            order,
          },
        },
      },
    })
    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    expect(JSON.parse(button.buttonParamsJson).order).toEqual({
      ...order,
      tax: { value: 0, offset: 100 },
    })
  })

  test('rejects incomplete dynamic PIX data', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-125',
            currency: 'BRL',
            total_amount: { value: 100, offset: 100 },
            payment_settings: [{
              type: 'pix_dynamic_code',
              pix_dynamic_code: { merchant_name: 'Viper Tec' },
            }],
          },
        },
      },
    })).rejects.toThrow('pix_dynamic_code_fields_required')
  })

  test('maps an order payment link to review_and_pay', async () => {
    const paymentSetting = {
      type: 'payment_link',
      payment_link: { uri: 'https://pagamentos.vipertec.com.br/pedido-126' },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-126',
            type: 'digital-goods',
            payment_type: 'br',
            payment_settings: [paymentSetting],
            currency: 'BRL',
            total_amount: { value: 1500, offset: 100 },
          },
        },
      },
    })
    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    expect(button.name).toBe('review_and_pay')
    expect(JSON.parse(button.buttonParamsJson).payment_settings).toEqual([paymentSetting])
  })

  test('maps a boleto order to review_and_pay', async () => {
    const paymentSetting = {
      type: 'boleto',
      boleto: { digitable_line: '03399026944140000002628346101018898510000008848' },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-127',
            type: 'physical-goods',
            payment_type: 'br',
            payment_settings: [paymentSetting],
            currency: 'BRL',
            total_amount: { value: 8900, offset: 100 },
          },
        },
      },
    })
    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    expect(button.name).toBe('review_and_pay')
    expect(JSON.parse(button.buttonParamsJson).payment_settings).toEqual([paymentSetting])
  })

  test('combines boleto and dynamic PIX in one subscription order', async () => {
    const paymentSettings = [
      {
        type: 'boleto',
        boleto: { digitable_line: '03399026944140000002628346101018898510000008848' },
      },
      {
        type: 'pix_dynamic_code',
        pix_dynamic_code: {
          code: '00020101021226700014br.gov.bcb.pix.example',
          merchant_name: 'Viper Tec',
          key: '12345678000199',
          key_type: 'CNPJ',
        },
      },
    ]
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        body: { text: 'Assinatura mensal do Plano Profissional' },
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'assinatura-2026-07',
            type: 'digital-goods',
            payment_type: 'br',
            payment_settings: paymentSettings,
            currency: 'BRL',
            total_amount: { value: 14990, offset: 100 },
            order: {
              status: 'pending',
              tax: { value: 0, offset: 100, description: 'Sem impostos adicionais' },
              items: [{
                retailer_id: 'plano-profissional',
                name: 'Plano Profissional - mensal',
                amount: { value: 14990, offset: 100 },
                quantity: 1,
              }],
              subtotal: { value: 14990, offset: 100 },
            },
          },
        },
      },
    })
    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    const parameters = JSON.parse(button.buttonParamsJson)
    expect(parameters.payment_settings).toEqual(paymentSettings)
    expect(parameters.order.items[0].name).toBe('Plano Profissional - mensal')
    expect(parameters.order.tax).toEqual({
      value: 0,
      offset: 100,
      description: 'Sem impostos adicionais',
    })
  })

  test('normalizes a formatted boleto line for the copy CTA', async () => {
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        body: { text: 'Boleto da assinatura' },
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'boleto-1033239253',
            type: 'digital-goods',
            payment_type: 'br',
            payment_settings: [{
              type: 'boleto',
              boleto: {
                digitable_line: '36490.00092 00055.252308 00000.010918 9 00000000006000',
              },
            }],
            currency: 'BRL',
            total_amount: { value: 6000, offset: 100 },
            order: {
              status: 'pending',
              items: [{
                retailer_id: 'camera-comodato-mensal',
                name: 'Câmera Comodato Mensal',
                amount: { value: 6000, offset: 100 },
                quantity: 1,
              }],
              subtotal: { value: 6000, offset: 100 },
            },
          },
        },
      },
    })

    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    const parameters = JSON.parse(button.buttonParamsJson)
    expect(parameters.payment_settings[0].boleto.digitable_line)
      .toBe('36490000920005525230800000010918900000000006000')
    expect(parameters.order.tax).toEqual({ value: 0, offset: 100 })
  })

  test('maps an enabled one-click card order to review_and_pay', async () => {
    const paymentSetting = {
      type: 'offsite_card_pay',
      offsite_card_pay: { last_four_digits: '5235', credential_id: 'credential-123' },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-128',
            type: 'digital-goods',
            payment_type: 'br',
            payment_settings: [paymentSetting],
            currency: 'BRL',
            total_amount: { value: 50000, offset: 100 },
          },
        },
      },
    })
    const button = (mapped.content as any).interactiveMessage.nativeFlowMessage.buttons[0]
    expect(button.name).toBe('review_and_pay')
    expect(JSON.parse(button.buttonParamsJson).payment_settings).toEqual([paymentSetting])
  })

  test('maps an order status update to the review_order native flow', async () => {
    const parameters = {
      reference_id: 'pedido-129',
      order: { status: 'processing' },
      payment: { status: 'captured', timestamp: 1722445231 },
    }
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_status',
        body: { text: 'Pagamento confirmado' },
        footer: { text: 'Estamos preparando seu pedido' },
        action: { name: 'review_order', parameters },
      },
    })
    expect(mapped.content).not.toHaveProperty('viewOnceMessage')
    const interactive = (mapped.content as any).interactiveMessage
    expect(interactive.nativeFlowMessage.buttons).toEqual([{
      name: 'review_order',
      buttonParamsJson: JSON.stringify(parameters),
    }])
    expect(interactive.nativeFlowMessage.messageParamsJson).toBe('{}')
  })

  test('uploads an image header for an itemized order', async () => {
    client.message.upload.mockResolvedValue({ url: 'https://cdn.test/order.jpg' } as any)
    const mapped = await toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        header: { type: 'image', image: { link: 'https://example.test/order.jpg' } },
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-130',
            type: 'physical-goods',
            payment_type: 'br',
            payment_settings: [{
              type: 'payment_link',
              payment_link: { uri: 'https://pagamentos.vipertec.com.br/pedido-130' },
            }],
            currency: 'BRL',
            total_amount: { value: 50000, offset: 100 },
            order: {
              status: 'pending',
              subtotal: { value: 50000, offset: 100 },
              items: [{ name: 'Produto', amount: { value: 50000, offset: 100 }, quantity: 1 }],
            },
          },
        },
      },
    })
    const header = (mapped.content as any).interactiveMessage.header
    expect(header).toEqual(expect.objectContaining({
      hasMediaAttachment: true,
      imageMessage: {
        url: 'https://cdn.test/order.jpg',
        jpegThumbnail: Uint8Array.from([9, 8, 7]),
        width: 1024,
        height: 1024,
      },
    }))
    expect(mockGenerateImageThumbnail).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]), 100)
  })

  test.each([
    [
      'static PIX',
      { type: 'pix_static_code', pix_static_code: { merchant_name: 'Viper Tec' } },
      'pix_static_code_fields_required',
    ],
    [
      'payment link',
      { type: 'payment_link', payment_link: {} },
      'payment_link_uri_required',
    ],
    [
      'boleto',
      { type: 'boleto', boleto: {} },
      'boleto_digitable_line_required',
    ],
    [
      'one-click card',
      { type: 'offsite_card_pay', offsite_card_pay: { last_four_digits: '5235' } },
      'offsite_card_pay_fields_required',
    ],
  ])('rejects incomplete %s payment settings', async (_name, paymentSetting, error) => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-incompleto',
            currency: 'BRL',
            total_amount: { value: 100, offset: 100 },
            payment_settings: [paymentSetting],
          },
        },
      },
    })).rejects.toThrow(error)
  })

  test('rejects an image header in a simplified order', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        header: { type: 'image', image: { link: 'https://example.test/order.jpg' } },
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-sem-itens',
            currency: 'BRL',
            total_amount: { value: 100, offset: 100 },
            payment_settings: [{
              type: 'payment_link',
              payment_link: { uri: 'https://pagamentos.vipertec.com.br/pedido-sem-itens' },
            }],
          },
        },
      },
    })).rejects.toThrow('order_details_image_requires_order')
  })

  test('rejects an incomplete order status update', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'order_status',
        action: {
          name: 'review_order',
          parameters: { reference_id: 'pedido-sem-status' },
        },
      },
    })).rejects.toThrow('order_status_parameters_required')
  })

  test('rejects a payment request without payment settings', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Finalize o pagamento' },
        action: { buttons: [{ type: 'payment_request', text: 'Pagar' }] },
      },
    })).rejects.toThrow('payment_request_setting_required')
  })

  test('adds the business native-flow node required by carousel cards', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'interactive',
      interactive: {
        type: 'carousel',
        body: { text: 'Conheça nossos planos' },
        action: {
          carousel: {
            cards: [
              {
                header: { type: 'text', text: 'Básico' },
                body: { text: 'Plano Básico' },
                action: { buttons: [{ type: 'reply', reply: { id: 'basico', title: 'Escolher' } }] },
              },
              {
                header: { type: 'text', text: 'Profissional' },
                body: { text: 'Plano Profissional' },
                action: { buttons: [{ type: 'reply', reply: { id: 'pro', title: 'Escolher' } }] },
              },
            ],
          },
        },
      },
    })).resolves.toEqual({
      content: {
        interactiveMessage: {
          header: { title: '', hasMediaAttachment: false },
          body: { text: 'Conheça nossos planos' },
          footer: undefined,
          carouselMessage: {
            cards: [
              {
                header: { title: 'Básico', hasMediaAttachment: false },
                body: { text: 'Plano Básico' },
                footer: undefined,
                nativeFlowMessage: {
                  buttons: [{
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({ display_text: 'Escolher', id: 'basico' }),
                  }],
                  messageVersion: 1,
                },
              },
              {
                header: { title: 'Profissional', hasMediaAttachment: false },
                body: { text: 'Plano Profissional' },
                footer: undefined,
                nativeFlowMessage: {
                  buttons: [{
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({ display_text: 'Escolher', id: 'pro' }),
                  }],
                  messageVersion: 1,
                },
              },
            ],
            messageVersion: 1,
            carouselCardType: 0,
          },
        },
      },
      options: {
        customNodes: [{
          tag: 'biz',
          attrs: {},
          content: [{
            tag: 'interactive',
            attrs: { type: 'native_flow', v: '1' },
            content: [{
              tag: 'native_flow',
              attrs: { v: '9', name: 'mixed' },
              content: undefined,
            }],
          }],
        }],
      },
    })
  })

  test('rejects a poll whose selectable count exceeds its options', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'poll',
      poll: { name: 'Escolha', options: ['A'], selectableCount: 2 },
    })).rejects.toThrow('invalid_poll_selectable_count')
  })

  test('rejects message types without a documented mapping', async () => {
    await expect(toZapoMessageContent(client, { type: 'unknown' })).rejects.toThrow('unsupported_zapo_message_type')
  })
})
