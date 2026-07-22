import { toUnoAddonEvent, toUnoMessageEvent, toUnoReceiptUpdates } from '../../src/services/zapo/zapo_events'

describe('Zapo event mapper', () => {
  test('maps an incoming Zapo message to the established Uno listener shape', () => {
    const event = {
      key: { remoteJid: '1@s.whatsapp.net', id: 'm1', fromMe: false, isGroup: false, isBroadcast: false, isNewsletter: false, senderDevice: 0 },
      message: { conversation: 'Oi' },
      timestampSeconds: 10,
      pushName: 'Maria',
      rawNode: {},
    } as never

    expect(toUnoMessageEvent(event)).toEqual(expect.objectContaining({
      key: expect.objectContaining({ id: 'm1', remoteJid: '1@s.whatsapp.net' }),
      message: { conversation: 'Oi' },
      messageTimestamp: 10,
      pushName: 'Maria',
    }))
  })

  test('fans out batched Zapo receipts into Uno message updates', () => {
    const updates = toUnoReceiptUpdates({
      chatJid: '1@s.whatsapp.net',
      messageIds: ['m1', 'm2'],
      status: 'read',
      participantJid: undefined,
    } as never)

    expect(updates).toHaveLength(2)
    expect(updates[0]).toEqual({
      key: { remoteJid: '1@s.whatsapp.net', id: 'm1', fromMe: true },
      update: { status: 'READ' },
    })
  })

  test('suppresses inactive receipts that have no Cloud API status equivalent', () => {
    expect(toUnoReceiptUpdates({ status: 'inactive', messageIds: ['m1'] } as never)).toEqual([])
  })

  test('uses Zapo decrypted addons instead of Baileys poll/reaction crypto fallbacks', () => {
    const mapped = toUnoAddonEvent({
      key: { remoteJid: '123@lid', id: 'reaction-1', fromMe: false },
      targetMessageId: 'message-1',
      kind: 'reaction',
      decrypted: { kind: 'reaction', reaction: { text: '👍' } },
    } as never)
    expect(mapped).toEqual(expect.objectContaining({
      message: {
        reactionMessage: expect.objectContaining({
          text: '👍',
          key: expect.objectContaining({ id: 'message-1' }),
        }),
      },
    }))
  })

  test('preserves the option names decrypted by Zapo for incoming poll votes', () => {
    const mapped = toUnoAddonEvent({
      key: { remoteJid: '120363@g.us', id: 'vote-1', fromMe: false },
      targetMessageId: 'poll-1',
      kind: 'poll_vote',
      decrypted: {
        kind: 'poll_vote',
        pollVote: { encPayload: Uint8Array.from([1]), encIv: Uint8Array.from([2]) },
        selectedOptionNames: ['Pizza', 'Sushi'],
      },
    } as never)

    expect(mapped).toEqual(expect.objectContaining({
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: expect.objectContaining({ id: 'poll-1' }),
          vote: expect.objectContaining({ selectedOptionNames: ['Pizza', 'Sushi'] }),
        },
      },
    }))
  })

  test('maps a Zapo message edit addon to the established protocol edit shape', () => {
    const mapped = toUnoAddonEvent({
      key: { remoteJid: '123@lid', id: 'edit-1', fromMe: true },
      targetMessageId: 'original-1',
      kind: 'message_edit',
      decrypted: { kind: 'message_edit', message: { conversation: 'texto corrigido' } },
    } as never)

    expect(mapped).toEqual(expect.objectContaining({
      message: {
        protocolMessage: {
          key: expect.objectContaining({ id: 'original-1' }),
          type: 'MESSAGE_EDIT',
          editedMessage: { conversation: 'texto corrigido' },
        },
      },
    }))
  })
})
