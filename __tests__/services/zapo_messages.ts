import { mockDeep } from 'jest-mock-extended'
import type { WaClient, WaStoreSession } from 'zapo-js'
import type { DataStore } from '../../src/services/data_store'
import { ZapoMessages } from '../../src/services/zapo/zapo_messages'

const publishResult = { id: 'provider-id', attempts: 1, ackNode: {}, ack: { refreshLid: false } } as never

describe('Zapo messages adapter', () => {
  test('sends typed text, stores the provider key and returns the UnoAPI response contract', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, dataStore)

    await expect(messages.send({ to: '556699999999', type: 'text', text: { body: 'Oi' } })).resolves.toEqual({
      ok: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '556699999999', wa_id: '5566999999999' }],
        messages: [{ id: expect.any(String) }],
      },
    })
    expect(client.message.send).toHaveBeenCalledWith(
      '5566999999999@s.whatsapp.net',
      { type: 'text', text: 'Oi' },
      {},
    )
    expect(dataStore.setKey).toHaveBeenCalledWith('provider-id', {
      remoteJid: '5566999999999@s.whatsapp.net', id: 'provider-id', fromMe: true,
    })
    expect(dataStore.setUnoId).toHaveBeenCalledWith('provider-id', expect.any(String))
    expect(dataStore.setKey).toHaveBeenCalledTimes(2)
  })

  test('normalizes Brazilian mobile numbers before entering the Zapo core', async () => {
    const client = mockDeep<WaClient>()
    client.message.send.mockResolvedValue(publishResult)
    const messages = new ZapoMessages(client, mockDeep<DataStore>())

    await messages.send({ to: '554988290955', type: 'text', text: { body: 'Oi' } })

    expect(client.message.send).toHaveBeenCalledWith('5549988290955@s.whatsapp.net', expect.anything(), {})
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

  test('uses the stored provider key for reactions, replies and edits', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    client.message.send.mockResolvedValue(publishResult)
    dataStore.loadProviderId.mockResolvedValue('original-provider-id')
    dataStore.loadKey.mockResolvedValue({ remoteJid: 'group@g.us', id: 'original-provider-id', fromMe: true })
    const messages = new ZapoMessages(client, dataStore)

    await messages.send({ to: 'group@g.us', type: 'reaction', reaction: { message_id: 'uno-id', emoji: '👍' } })
    await messages.send({ to: 'group@g.us', type: 'text', text: { body: 'resposta' }, context: { message_id: 'uno-id' } })
    await messages.send({ to: 'group@g.us', type: 'message_edit', text: { body: 'corrigido' }, context: { message_id: 'uno-id' } })

    expect(client.message.send).toHaveBeenNthCalledWith(1, 'group@g.us', expect.objectContaining({ type: 'reaction' }), {})
    expect(client.message.send).toHaveBeenNthCalledWith(2, 'group@g.us', expect.anything(), expect.objectContaining({ quote: expect.objectContaining({ id: 'original-provider-id' }) }))
    expect(client.message.send).toHaveBeenNthCalledWith(3, 'group@g.us', expect.anything(), expect.objectContaining({ editKey: expect.objectContaining({ id: 'original-provider-id' }) }))
  })

  test('maps read and delete statuses to Zapo receipt and revoke operations', async () => {
    const client = mockDeep<WaClient>()
    const dataStore = mockDeep<DataStore>()
    dataStore.loadKey.mockResolvedValue({ remoteJid: '1@s.whatsapp.net', id: 'm1', fromMe: false })
    const messages = new ZapoMessages(client, dataStore)

    await messages.updateStatus({ status: 'read', message_id: 'm1' })
    await messages.updateStatus({ status: 'deleted', message_id: 'm1' })

    expect(client.message.sendReceipt).toHaveBeenCalledWith('1@s.whatsapp.net', 'm1', { type: 'read' })
    expect(client.message.send).toHaveBeenCalledWith('1@s.whatsapp.net', expect.objectContaining({ type: 'revoke' }))
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

  test('builds interactive lists as a native-flow proto message for Zapo', async () => {
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
      expect.objectContaining({
        interactiveMessage: expect.objectContaining({
          nativeFlowMessage: expect.objectContaining({
            buttons: [expect.objectContaining({ name: 'single_select' })],
          }),
        }),
      }),
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
