import { packWaMessage, unpackWaMessage } from '../../src/services/wa_message_envelope'

describe('WA message AMQP envelope', () => {
  test('preserves Zapo alternate addressing omitted by WAProto MessageKey', () => {
    const original = {
      key: {
        remoteJid: '11343495192601@lid',
        remoteJidAlt: '5566999554300@s.whatsapp.net',
        id: 'echo-1',
        fromMe: true,
        isGroup: false,
      },
      message: { conversation: 'eco' },
    }

    const unpacked = unpackWaMessage(packWaMessage(original))

    expect(unpacked).toEqual(expect.objectContaining({
      key: expect.objectContaining(original.key),
      message: expect.objectContaining({ conversation: 'eco' }),
    }))
  })

  test('preserves group participant identity and username', () => {
    const original = {
      key: {
        remoteJid: '120363039221813429@g.us',
        participant: '123456789@lid',
        participantAlt: '5566991112222@s.whatsapp.net',
        participantUsername: 'cliente.teste',
        id: 'group-1',
        fromMe: false,
        isGroup: true,
      },
      message: { conversation: 'grupo' },
    }

    const unpacked = unpackWaMessage(packWaMessage(original))

    expect(unpacked.key).toEqual(expect.objectContaining(original.key))
  })

  test('leaves non-message payloads unchanged', () => {
    const update = { update: { status: 'READ' } }

    expect(packWaMessage(update)).toBe(update)
    expect(unpackWaMessage(update)).toBe(update)
  })
})
