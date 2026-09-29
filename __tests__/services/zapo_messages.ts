import { mockDeep } from 'jest-mock-extended'
import fetch from 'node-fetch'
import type { WaClient, WaStoreSession } from 'zapo-js'
import type { DataStore } from '../../src/services/data_store'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'

jest.mock('node-fetch', () => jest.fn())

const mockedFetch = fetch as unknown as jest.Mock

const publishResult = { id: 'provider-id', attempts: 1, ackNode: {}, ack: { refreshLid: false } } as never

describe('Zapo messages adapter', () => {
  test.each(['image', 'video', 'audio'])('passes %s viewOnce to the actual SDK send call', async type => {
    const client = mockDeep<WaClient>(), dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, dataStore)
    await messages.send({ to: '123@lid', type, [type]: { link: '/test/media', view_once: true } })
    expect(client.message.send).toHaveBeenCalledTimes(1)
    expect(client.message.send).toHaveBeenCalledWith('123@lid', expect.objectContaining({ type, media: '/test/media' }), expect.objectContaining({ viewOnce: true }))
  })
  test('sends static location with a resolved reply and retains the Uno/provider ID mapping', async () => {
    const client = mockDeep<WaClient>(), dataStore = mockDeep<DataStore>()
    const key = { remoteJid: '123@lid', id: 'original-provider-id', fromMe: false }
    dataStore.loadKey.mockResolvedValue(key)
    dataStore.setUnoId.mockResolvedValue('uno-location')
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, dataStore)
    const result = await messages.send({ to: '123@lid', type: 'location', location: { latitude: 0, longitude: 0 }, context: { message_id: 'uno-original' } })
    expect(client.message.send).toHaveBeenCalledWith('123@lid', { locationMessage: { degreesLatitude: 0, degreesLongitude: 0 } }, expect.objectContaining({ quote: key }))
    expect(dataStore.setUnoId).toHaveBeenCalledWith('provider-id', expect.any(String))
    expect(result).toMatchObject({ ok: { messages: [{ id: 'uno-location' }] } })
  })
  test('confirmed send archives wire content while preserving queued UnoID mapping; failed send does not archive', async () => {
    const client = mockDeep<WaClient>(), dataStore = mockDeep<DataStore>(), store = mockDeep<WaStoreSession>()
    const messages = new ZapoMessages(client, dataStore, { store })
    dataStore.setUnoId.mockResolvedValue('uno-queued')
    client.message.send.mockImplementation(async () => {
      messages.sentArchive.capture({ id: 'provider-id', to: '123@lid', message: { conversation: 'Oi' } })
      return publishResult
    })
    const result = await messages.send({ to: '123@lid', type: 'text', text: { body: 'Oi' } }, { unoMessageId: 'uno-queued' })
    expect(result).toMatchObject({ ok: { messages: [{ id: 'uno-queued' }] } })
    expect(dataStore.setUnoId).toHaveBeenCalledWith('provider-id', 'uno-queued')
    expect(dataStore.setKey).toHaveBeenCalledWith('uno-queued', { id: 'provider-id', remoteJid: '123@lid', fromMe: true })
    expect(store.messages.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider-id', fromMe: true }))
    store.messages.upsert.mockClear()
    client.message.send.mockImplementation(async () => {
      messages.sentArchive.capture({ id: 'failed', to: '123@lid', message: { conversation: 'not sent' } })
      throw new Error('transport_failed')
    })
    await expect(messages.send({ to: '123@lid', type: 'text', text: { body: 'not sent' } })).rejects.toThrow()
    expect(store.messages.upsert).not.toHaveBeenCalled()
  })

  test('sends typed text, stores the provider key and returns the UnoAPI response contract', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, dataStore)
    messages.sentArchive.capture({ id: 'provider-id', to: '556699999999@s.whatsapp.net', message: { conversation: 'Oi' } })

    await expect(messages.send({ to: '556699999999', type: 'text', text: { body: 'Oi' } })).resolves.toEqual({
      ok: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '556699999999', wa_id: '556699999999' }],
        messages: [{ id: expect.any(String) }],
      },
    })
    expect(client.message.send).toHaveBeenCalledWith(
      '556699999999@s.whatsapp.net',
      { type: 'text', text: 'Oi' },
      {},
    )
    expect(dataStore.setKey).toHaveBeenCalledWith('provider-id', {
      remoteJid: '556699999999@s.whatsapp.net', id: 'provider-id', fromMe: true,
    })
    expect(dataStore.setUnoId).toHaveBeenCalledWith('provider-id', expect.any(String))
    expect(dataStore.setKey).toHaveBeenCalledTimes(2)
    expect(dataStore.setMessage).toHaveBeenCalledWith(
      '556699999999@s.whatsapp.net',
      expect.objectContaining({
        key: { remoteJid: '556699999999@s.whatsapp.net', id: 'provider-id', fromMe: true },
        message: expect.objectContaining({ conversation: 'Oi' }),
      }),
    )
  })

  test('quotes the original order when sending an order status update', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    const originalMessage = {
      interactiveMessage: {
        body: { text: 'Pedido original' },
        nativeFlowMessage: {
          buttons: [{
            name: 'review_and_pay',
            buttonParamsJson: JSON.stringify({ reference_id: 'pedido-v5' }),
          }],
        },
      },
    }
    client.message.send
      .mockResolvedValueOnce({ id: 'order-provider-id' } as never)
      .mockResolvedValueOnce({ id: 'status-provider-id' } as never)
    dataStore.loadKey.mockImplementation(async (id) => id === 'zapo-order-reference:pedido-v5'
      ? { remoteJid: '5511999999999@s.whatsapp.net', id: 'order-provider-id', fromMe: true }
      : undefined)
    dataStore.loadMessageExact?.mockResolvedValue({
      key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'order-provider-id', fromMe: true },
      message: originalMessage,
    } as never)
    const messages = new ZapoMessages(client, dataStore)

    await messages.send({
      to: '5511999999999',
      type: 'interactive',
      interactive: {
        type: 'order_details',
        body: { text: 'Pedido original' },
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: 'pedido-v5',
            type: 'digital-goods',
            payment_type: 'br',
            payment_settings: [{
              type: 'pix_dynamic_code',
              pix_dynamic_code: { code: 'pix', merchant_name: 'Loja', key: 'chave', key_type: 'EVP' },
            }],
            currency: 'BRL',
            total_amount: { value: 6000, offset: 100 },
          },
        },
      },
    })
    await messages.send({
      to: '5511999999999',
      type: 'interactive',
      interactive: {
        type: 'order_status',
        body: { text: 'Pagamento confirmado' },
        action: {
          name: 'review_order',
          parameters: {
            reference_id: 'pedido-v5',
            order: { status: 'completed' },
            payment: { status: 'captured' },
          },
        },
      },
    })

    expect(dataStore.setKey).toHaveBeenCalledWith(
      'zapo-order-reference:pedido-v5',
      { remoteJid: '5511999999999@s.whatsapp.net', id: 'order-provider-id', fromMe: true },
    )
    expect(client.message.send).toHaveBeenNthCalledWith(
      2,
      '5511999999999@s.whatsapp.net',
      expect.objectContaining({ interactiveMessage: expect.any(Object) }),
      {
        quote: {
          id: 'order-provider-id',
          remoteJid: '5511999999999@s.whatsapp.net',
          fromMe: true,
          message: originalMessage,
        },
      },
    )
  })

  test('stores and quotes a legacy payment request normalized to review_and_pay', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    const originalMessage = {
      interactiveMessage: {
        body: { text: 'PIX legado' },
        nativeFlowMessage: {
          buttons: [{
            name: 'review_and_pay',
            buttonParamsJson: JSON.stringify({ reference_id: 'pix-legado-123' }),
          }],
        },
      },
    }
    client.message.send
      .mockResolvedValueOnce({ id: 'legacy-order-provider-id' } as never)
      .mockResolvedValueOnce({ id: 'legacy-status-provider-id' } as never)
    dataStore.loadKey.mockImplementation(async (id) => id === 'zapo-order-reference:pix-legado-123'
      ? { remoteJid: '5511999999999@s.whatsapp.net', id: 'legacy-order-provider-id', fromMe: true }
      : undefined)
    dataStore.loadMessageExact?.mockResolvedValue({
      key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'legacy-order-provider-id', fromMe: true },
      message: originalMessage,
    } as never)
    const messages = new ZapoMessages(client, dataStore)

    await messages.send({
      to: '5511999999999',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Pague via PIX' },
        action: {
          buttons: [{
            type: 'payment_request',
            payment_request: {
              reference_id: 'pix-legado-123',
              type: 'digital-goods',
              payment_type: 'br',
              payment_settings: [{
                type: 'pix_dynamic_code',
                pix_dynamic_code: { code: 'pix', merchant_name: 'Loja', key: 'chave', key_type: 'EVP' },
              }],
              currency: 'BRL',
              total_amount: { value: 6000, offset: 100 },
            },
          }],
        },
      },
    })
    await messages.send({
      to: '5511999999999',
      type: 'interactive',
      interactive: {
        type: 'order_status',
        body: { text: 'Pagamento confirmado' },
        action: {
          name: 'review_order',
          parameters: {
            reference_id: 'pix-legado-123',
            order: { status: 'processing' },
            payment: { status: 'captured' },
          },
        },
      },
    })

    expect(dataStore.setKey).toHaveBeenCalledWith(
      'zapo-order-reference:pix-legado-123',
      { remoteJid: '5511999999999@s.whatsapp.net', id: 'legacy-order-provider-id', fromMe: true },
    )
    expect(client.message.send).toHaveBeenNthCalledWith(
      2,
      '5511999999999@s.whatsapp.net',
      expect.objectContaining({ interactiveMessage: expect.any(Object) }),
      {
        quote: {
          id: 'legacy-order-provider-id',
          remoteJid: '5511999999999@s.whatsapp.net',
          fromMe: true,
          message: originalMessage,
        },
      },
    )
  })

  test('preserves the supplied phone while Zapo resolves its LID', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({ to: '554988290955', type: 'text', text: { body: 'Oi' } })

    expect(client.message.send).toHaveBeenCalledWith('554988290955@s.whatsapp.net', expect.anything(), {})
  })

  test('routes by explicit LID and reports the exact PN stored by Zapo', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    client.message.send.mockResolvedValue(publishResult)
    store.contacts.getByJid.mockResolvedValue({
      jid: '273877414502425@lid',
      lid: '273877414502425@lid',
      phoneNumber: '556696890270@s.whatsapp.net',
    } as never)
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { store })

    const response = await messages.send({
      to: '5566996890270',
      user_id: '273877414502425@lid',
      type: 'text',
      text: { body: 'Oi' },
    })

    expect(client.message.send).toHaveBeenCalledWith(
      '273877414502425@lid',
      { type: 'text', text: 'Oi' },
      {},
    )
    expect(response.ok?.contacts).toEqual([{
      input: '5566996890270',
      wa_id: '556696890270',
      user_id: '273877414502425@lid',
    }])
  })

  test('downloads a remote sticker before passing it to the Zapo media API', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    })
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({
      to: '5511999999999',
      type: 'sticker',
      sticker: { link: 'https://chatwoot.example/sticker.webp', mime_type: 'image/webp' },
    })

    expect(mockedFetch).toHaveBeenCalledWith('https://chatwoot.example/sticker.webp')
    expect(client.message.send).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      expect.objectContaining({
        type: 'sticker',
        media: Uint8Array.from([1, 2, 3]),
        mimetype: 'image/webp',
      }),
      {},
    )
  })

  test('maps outgoing voice audio to the Zapo audio builder with PTT enabled', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer,
    })
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({
      to: '5511999999999',
      type: 'audio',
      audio: { link: 'https://chatwoot.example/voice.mp3', mime_type: 'audio/mpeg' },
    })

    expect(client.message.send).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      expect.objectContaining({
        type: 'audio',
        ptt: true,
        media: Uint8Array.from([4, 5, 6]),
        mimetype: 'audio/mpeg',
      }),
      {},
    )
  })

  test('uses the queue Uno id directly so receipts do not require an id chain', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue({ id: '3EB0PROVIDER' } as never)
    dataStore.setUnoId.mockResolvedValue('uno-from-queue')
    const messages = new ZapoMessages(client, dataStore)

    const response = await messages.send(
      { to: '5511999999999', type: 'text', text: { body: 'Oi' } },
      { unoMessageId: 'uno-from-queue', requestId: 'internal-only' },
    )

    expect(dataStore.setUnoId).toHaveBeenCalledWith('3EB0PROVIDER', 'uno-from-queue')
    expect(response.ok?.messages).toEqual([{ id: 'uno-from-queue' }])
    expect(client.message.send).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      { type: 'text', text: 'Oi' },
      {},
    )
  })

  test('uses LID as the canonical direct and mention identity when the Zapo contact store knows the PN alias', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    client.message.send.mockResolvedValue(publishResult)
    store.contacts.getByPhoneNumber.mockImplementation(async (phone) => (
      `${phone}`.startsWith('5511999999999')
        ? { jid: '123456@lid', lid: '123456@lid', phoneNumber: '5511999999999', lastUpdatedMs: 1 }
        : null
    ))
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { store })

    await messages.send({
      to: '5511999999999',
      type: 'text',
      text: { body: '@5511999999999 oi', mentions: ['5511999999999'] },
    })

    expect(client.message.send).toHaveBeenCalledWith(
      '123456@lid',
      { type: 'text', text: '@5511999999999 oi' },
      { mentions: ['123456@lid'] },
    )
  })

  test('does not reinterpret an explicit LID mention found in the text as a phone number', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { store })

    await messages.send({
      to: '120363403929702389@g.us',
      type: 'text',
      text: { body: 'opa @3418911461468 vamo ver la' },
      mentions: ['3418911461468@lid'],
    })

    expect(client.profile.getLidsByPhoneNumbers).not.toHaveBeenCalled()
    expect(client.message.send).toHaveBeenCalledWith(
      '120363403929702389@g.us',
      { type: 'text', text: 'opa @3418911461468 vamo ver la' },
      { mentions: ['3418911461468@lid'] },
    )
  })

  test('recovers privacy material and retries once after a 463 nack', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    store.contacts.getByPhoneNumber.mockResolvedValue({ jid: '123456@lid', lid: '123456@lid', phoneNumber: '5511999999999' } as never)
    store.privacyToken.getByJid.mockImplementation(async (jid) => (
      jid === '__nct_salt__' && client.chat.sync.mock.calls.length
        ? { jid, nctSalt: Uint8Array.from([1]), updatedAtMs: 1 } as never
        : null
    ))
    client.message.send
      .mockRejectedValueOnce(new Error('negative publish ack error=463'))
      .mockResolvedValueOnce(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { store })

    await expect(messages.send({ to: '5511999999999', type: 'text', text: { body: 'Oi' } })).resolves.toEqual(
      expect.objectContaining({ ok: expect.any(Object) }),
    )
    expect(client.chat.sync).toHaveBeenCalledTimes(1)
    expect(client.message.send).toHaveBeenCalledTimes(2)
  })

  test('refreshes an invalid LID from the phone network mapping, updates caches and retries once', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    const store = mockDeep<WaStoreSession>()
    const staleLid = '43731474477087@lid'
    const refreshedLid = '98765432100000@lid'
    store.contacts.getByJid.mockResolvedValue({
      jid: staleLid,
      lid: staleLid,
      phoneNumber: '5566999810771',
    } as never)
    client.profile.getLidsByPhoneNumbers.mockResolvedValue([{
      queriedJid: '5566999810771@s.whatsapp.net',
      phoneJid: '5566999810771@s.whatsapp.net',
      lidJid: refreshedLid,
      exists: true,
    }] as never)
    client.message.send
      .mockRejectedValueOnce(new Error(`LID not found: ${staleLid}`))
      .mockResolvedValueOnce(publishResult)
    const messages = new ZapoMessages(client, dataStore, { store, phone: '5566999554300' })

    const response = await messages.send({
      to: '5566999810771',
      user_id: staleLid,
      type: 'text',
      text: { body: 'Oi' },
    })

    expect(client.message.send).toHaveBeenNthCalledWith(1, staleLid, { type: 'text', text: 'Oi' }, {})
    expect(client.message.send).toHaveBeenNthCalledWith(2, refreshedLid, { type: 'text', text: 'Oi' }, {})
    expect(client.profile.getLidsByPhoneNumbers).toHaveBeenCalledTimes(1)
    expect(client.profile.getLidsByPhoneNumbers).toHaveBeenCalledWith(['5566999810771@s.whatsapp.net'])
    expect(dataStore.removeJidMapping).toHaveBeenCalledWith(
      '5566999554300',
      '5566999810771@s.whatsapp.net',
      staleLid,
    )
    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      '5566999554300',
      '5566999810771@s.whatsapp.net',
      refreshedLid,
    )
    expect(store.contacts.deleteByJid).toHaveBeenCalledWith(staleLid)
    expect(response.ok?.contacts).toEqual([{
      input: '5566999810771',
      wa_id: '5566999810771',
      user_id: refreshedLid,
    }])
  })

  test('uses a cached LID for a phone-only payload and refreshes it only when the send rejects that LID', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    const store = mockDeep<WaStoreSession>()
    const staleLid = '43731474477087@lid'
    const refreshedLid = '98765432100000@lid'
    store.contacts.getByPhoneNumber.mockResolvedValue({
      jid: staleLid,
      lid: staleLid,
      phoneNumber: '5566999810771',
    } as never)
    client.profile.getLidsByPhoneNumbers.mockResolvedValue([{
      queriedJid: '5566999810771@s.whatsapp.net',
      phoneJid: '5566999810771@s.whatsapp.net',
      lidJid: refreshedLid,
      exists: true,
    }] as never)
    client.message.send
      .mockRejectedValueOnce(new Error(`LID not found: ${staleLid}`))
      .mockResolvedValueOnce(publishResult)
    const messages = new ZapoMessages(client, dataStore, { store, phone: '5566999554300' })

    const response = await messages.send({
      to: '5566999810771',
      type: 'text',
      text: { body: 'Oi' },
    })

    expect(client.message.send).toHaveBeenNthCalledWith(1, staleLid, { type: 'text', text: 'Oi' }, {})
    expect(client.message.send).toHaveBeenNthCalledWith(2, refreshedLid, { type: 'text', text: 'Oi' }, {})
    expect(client.profile.getLidsByPhoneNumbers).toHaveBeenCalledTimes(1)
    expect(dataStore.removeJidMapping).toHaveBeenCalledWith(
      '5566999554300',
      '5566999810771@s.whatsapp.net',
      staleLid,
    )
    expect(dataStore.setJidMapping).toHaveBeenCalledWith(
      '5566999554300',
      '5566999810771@s.whatsapp.net',
      refreshedLid,
    )
    expect(response.ok?.contacts).toEqual([{
      input: '5566999810771',
      wa_id: '5566999810771',
      user_id: refreshedLid,
    }])
  })

  test('does not query the network or retry for unrelated send failures', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    client.message.send.mockRejectedValue(new Error('socket closed'))
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { store, phone: 'session' })

    await expect(messages.send({
      to: '5566999810771',
      user_id: '43731474477087@lid',
      type: 'text',
      text: { body: 'Oi' },
    })).rejects.toThrow('socket closed')

    expect(client.profile.getLidsByPhoneNumbers).not.toHaveBeenCalled()
    expect(client.message.send).toHaveBeenCalledTimes(1)
  })

  test('uses the stored provider key for reactions and replies', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    dataStore.loadProviderId.mockResolvedValue('original-provider-id')
    dataStore.loadKey.mockResolvedValue({ remoteJid: 'group@g.us', id: 'original-provider-id', fromMe: true })
    const messages = new ZapoMessages(client, dataStore)

    await messages.send({ to: 'group@g.us', type: 'reaction', reaction: { message_id: 'uno-id', emoji: '👍' } })
    await messages.send({ to: 'group@g.us', type: 'text', text: { body: 'resposta' }, context: { message_id: 'uno-id' } })

    expect(client.message.send).toHaveBeenNthCalledWith(1, 'group@g.us', expect.objectContaining({ type: 'reaction' }), {})
    expect(client.message.send).toHaveBeenNthCalledWith(2, 'group@g.us', expect.anything(), expect.objectContaining({ quote: expect.objectContaining({ id: 'original-provider-id' }) }))
  })

  test('edits an outgoing message using the explicit Zapo edit key', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    dataStore.loadProviderId.mockResolvedValue('original-provider-id')
    dataStore.loadKey.mockResolvedValue({
      remoteJid: '120363000000000000@g.us',
      id: 'original-provider-id',
      fromMe: true,
      participant: '111@lid',
    })
    const messages = new ZapoMessages(client, dataStore)

    await messages.send({
      to: '120363000000000000@g.us',
      type: 'message_edit',
      context: { message_id: 'uno-original-id' },
      text: { body: 'texto corrigido', mentions: ['222@lid'] },
    })

    expect(dataStore.loadProviderId).toHaveBeenCalledWith('uno-original-id')
    expect(client.message.send).toHaveBeenCalledWith(
      '120363000000000000@g.us',
      { type: 'text', text: 'texto corrigido' },
      {
        editKey: { id: 'original-provider-id', participant: '111@lid' },
        mentions: ['222@lid'],
      },
    )
  })

  test('rejects message edit without an original Uno message id', async () => {
    const messages = new ZapoMessages(mockDeep<WaClient>(), mockDeep<DataStore>())
    await expect(messages.send({
      to: '5511999999999',
      type: 'message_edit',
      text: { body: 'texto corrigido' },
    })).rejects.toThrow('message_edit_message_id_required')
  })

  test('rejects editing a message that was not sent by the connected account', async () => {
    const dataStore = mockDeep<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('incoming-provider-id')
    dataStore.loadKey.mockResolvedValue({
      remoteJid: '123@lid',
      id: 'incoming-provider-id',
      fromMe: false,
    })
    const messages = new ZapoMessages(mockDeep<WaClient>(), dataStore)

    await expect(messages.send({
      to: '123@lid',
      type: 'message_edit',
      context: { message_id: 'incoming-uno-id' },
      text: { body: 'não permitido' },
    })).rejects.toThrow('message_edit_original_not_from_me')
  })

  test('sends poll creation through the native Zapo poll API', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({
      to: '5511999999999',
      type: 'poll',
      poll: { name: 'Almoço?', options: ['Pizza', 'Sushi'], selectableCount: 1 },
    })

    expect(client.message.send).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      {
        type: 'poll',
        name: 'Almoço?',
        options: ['Pizza', 'Sushi'],
        selectableCount: 1,
        allowAddOption: false,
        hideParticipantName: false,
      },
      {},
    )
  })

  test('uses the stored poll secret to send a native Zapo group vote', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    const store = mockDeep<WaStoreSession>()
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index)
    client.message.send.mockResolvedValue(publishResult)
    dataStore.loadProviderId.mockResolvedValue('poll-provider-id')
    dataStore.loadKey.mockResolvedValue({
      remoteJid: '120363000000000000@g.us',
      id: 'poll-provider-id',
      fromMe: false,
      participant: '111@lid',
    })
    store.messageSecret.get.mockResolvedValue({
      messageId: 'poll-provider-id',
      secret,
      senderJid: '111@lid',
      createdAtMs: 1,
    })
    const messages = new ZapoMessages(client, dataStore, { store })

    await messages.send({
      to: '120363000000000000@g.us',
      type: 'poll_vote',
      poll_vote: { message_id: 'uno-poll-id', selected_options: ['Pizza'] },
    })

    expect(client.message.send).toHaveBeenCalledWith(
      '120363000000000000@g.us',
      {
        type: 'poll-vote',
        poll: {
          id: 'poll-provider-id',
          fromMe: false,
          authorJid: '111@lid',
          messageSecret: secret,
          participant: '111@lid',
        },
        selectedOptionNames: ['Pizza'],
      },
      {},
    )
  })

  test('returns a group contact instead of classifying the group JID as username', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    const response = await messages.send({
      to: '120363427999345040@g.us',
      type: 'text',
      text: { body: 'Oi grupo' },
    })

    expect(response.ok).toEqual(expect.objectContaining({
      contacts: [{
        input: '120363427999345040@g.us',
        wa_id: '120363427999345040@g.us',
        group_id: '120363427999345040@g.us',
      }],
    }))
  })

  test('maps read and delete statuses to Zapo receipt and revoke operations', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('provider-m1')
    dataStore.loadKey.mockResolvedValue({ remoteJid: '1@s.whatsapp.net', id: 'provider-m1', fromMe: true })
    const messages = new ZapoMessages(client, dataStore)

    await messages.updateStatus({ status: 'read', message_id: 'uno-m1' })
    await messages.updateStatus({ status: 'deleted', message_id: 'uno-m1' })

    expect(client.message.sendReceipt).toHaveBeenCalledWith('1@s.whatsapp.net', 'provider-m1', { type: 'read' })
    expect(client.message.send).toHaveBeenCalledWith('1@s.whatsapp.net', {
      type: 'revoke',
      target: {
        remoteJid: '1@s.whatsapp.net',
        id: 'provider-m1',
        fromMe: true,
      },
    })
    expect(dataStore.setStatus).toHaveBeenNthCalledWith(1, 'uno-m1', 'read')
    expect(dataStore.setStatus).toHaveBeenNthCalledWith(2, 'uno-m1', 'deleted')
  })

  test.each([
    ['read', 'read'],
    ['read', 'deleted'],
    ['deleted', 'deleted'],
  ])('does not repeat an already applied %s status when current status is %s', async (status, currentStatus) => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    dataStore.loadStatus.mockResolvedValue(currentStatus as never)
    const messages = new ZapoMessages(client, dataStore)

    await expect(messages.updateStatus({ status, message_id: 'uno-m1' })).resolves.toEqual({
      ok: { success: true },
    })

    expect(client.message.send).not.toHaveBeenCalled()
    expect(client.message.sendReceipt).not.toHaveBeenCalled()
    expect(dataStore.loadKey).not.toHaveBeenCalled()
    expect(dataStore.setStatus).not.toHaveBeenCalled()
  })

  test('returns a clear error when a referenced message key is missing', async () => {
    const messages = new ZapoMessages(mockDeep<WaClient>(), mockDeep<DataStore>())
    await expect(messages.updateStatus({ status: 'read', message_id: 'missing' })).rejects.toThrow('message_not_found')
  })

  test('emits composing and paused presence around direct messages when configured', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { composingMessage: true })

    await messages.send({ to: '5566', type: 'text', text: { body: 'Oi' } })

    expect(client.presence.sendChatstate).toHaveBeenNthCalledWith(1, '5566@s.whatsapp.net', { state: 'composing' })
    expect(client.presence.sendChatstate).toHaveBeenNthCalledWith(2, '5566@s.whatsapp.net', { state: 'paused' })
  })

  test.each([
    ['composing', [new Error('composing unavailable'), undefined]],
    ['paused', [undefined, new Error('paused unavailable')]],
  ])('does not fail an already valid send when %s presence fails', async (_state, results) => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    for (const result of results) {
      if (result instanceof Error) client.presence.sendChatstate.mockRejectedValueOnce(result)
      else client.presence.sendChatstate.mockResolvedValueOnce(undefined)
    }
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { composingMessage: true })

    await expect(messages.send({ to: '5566', type: 'text', text: { body: 'Oi' } }))
      .resolves.toEqual(expect.objectContaining({ ok: expect.any(Object) }))
    expect(client.message.send).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['provider id', 'provider-incoming-1', undefined],
    ['cached Uno id', 'uno-incoming-1', 'provider-incoming-1'],
  ])('marks the last incoming message as read after replying with a %s', async (_kind, cachedId, mappedProviderId) => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    dataStore.getLidForPn.mockResolvedValue('123456@lid')
    dataStore.getLastIncomingKey.mockImplementation(async (jid) => jid === '123456@lid'
      ? { remoteJid: '123456@lid', id: cachedId, fromMe: false }
      : undefined)
    dataStore.loadProviderId.mockImplementation(async (id) =>
      id === cachedId ? mappedProviderId : undefined)
    const messages = new ZapoMessages(client, dataStore, {
      readOnReply: true,
      phone: '5566996328386',
    })

    await messages.send({ to: '5566', type: 'text', text: { body: 'Resposta' } })

    expect(client.message.sendReceipt).toHaveBeenCalledWith(
      '123456@lid',
      'provider-incoming-1',
      { type: 'read' },
    )
  })

  test('does not mark messages as read on reply when the option is disabled', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({ to: '5566', type: 'text', text: { body: 'Resposta' } })

    expect(client.message.sendReceipt).not.toHaveBeenCalled()
  })

  test('publishes Status through the official status coordinator', async () => {
    const client = mockDeep<WaClient>()
    client.status.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send(
      { to: 'status@broadcast', type: 'text', text: { body: 'Meu status' } },
      { statusJidList: ['5511@s.whatsapp.net'], statusSetting: 'contacts' },
    )

    expect(client.status.send).toHaveBeenCalledWith({
      content: { type: 'text', text: 'Meu status' },
      recipients: ['5511@s.whatsapp.net'],
      statusSetting: 'contacts',
    })
    expect(client.message.send).not.toHaveBeenCalled()
  })

  test('builds interactive lists as the documented raw listMessage for Zapo', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({
      to: '5511999999999',
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Escolha' },
        action: {
          button: 'Abrir',
          sections: [{ title: 'Opcoes', rows: [{ id: 'one', title: 'Um' }] }],
        },
      },
    })

    expect(client.message.send).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      {
        listMessage: {
          title: '',
          description: 'Escolha',
          buttonText: 'Abrir',
          footerText: '',
          listType: 1,
          sections: [{
            title: 'Opcoes',
            rows: [{
              rowId: 'one',
              title: 'Um',
              description: '',
            }],
          }],
        },
      },
      {},
    )
  })

  test('binds Uno templates before translating them to the Zapo typed API', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const bindTemplate = jest.fn().mockResolvedValue({ text: 'Olá Maria' })
    const messages = new ZapoMessages(client, mockDeep<DataStore>(), { bindTemplate })

    await messages.send({
      to: '5511999999999',
      type: 'template',
      template: { name: 'boas-vindas', components: [] },
    })

    expect(bindTemplate).toHaveBeenCalled()
    expect(client.message.send).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      { type: 'text', text: 'Olá Maria' },
      {},
    )
  })

  test('rejects Status without a recipient distribution list', async () => {
    const messages = new ZapoMessages(mockDeep<WaClient>(), mockDeep<DataStore>())
    await expect(messages.send({ to: 'status@broadcast', type: 'text', text: { body: 'Meu status' } }, {}))
      .rejects.toThrow('status_recipients_required')
  })

  test('retries delivery with the official idempotent Zapo message id', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue({ id: 'provider-1' } as never)
    dataStore.loadProviderId.mockResolvedValue('provider-1')
    dataStore.loadKey.mockResolvedValue({ id: 'provider-1', remoteJid: '123@lid', fromMe: true } as never)
    dataStore.loadMessage.mockResolvedValue({ message: { conversation: 'Oi' } } as never)
    const messages = new ZapoMessages(client, dataStore)

    const response = await messages.recoverDelivery({ message_id: 'uno-1' })

    expect(client.message.send).toHaveBeenCalledWith(
      '123@lid',
      { conversation: 'Oi' },
      expect.objectContaining({ id: 'provider-1' }),
    )
    expect(response.ok).toEqual(expect.objectContaining({
      messages: [{ id: 'uno-1' }],
      recovery: expect.objectContaining({ provider_managed_sessions: true }),
    }))
  })
})
