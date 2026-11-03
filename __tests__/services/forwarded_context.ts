import { withForwardedContext } from '../../src/services/transformer/forwarded_context'
import { fromBaileysMessageContent } from '../../src/services/transformer'
import { toUnoMessageEvent } from '../../src/services/zapo/zapo_events'

describe('webhook forwarded context contract', () => {
  test.each([undefined, null, {}, { isForwarded: false }, { isForwarded: 'true' }, { isForwarded: 1 }, { forwardingScore: 99 }])('does not infer a forwarding marker from %p', contextInfo => {
    expect(withForwardedContext(undefined, contextInfo as never)).toBeUndefined()
    const context = { id: 'reply-id', message_id: 'reply-id' }
    expect(withForwardedContext(context, contextInfo as never)).toBe(context)
  })
  test('adds an explicit boolean without changing existing context or leaking provider metadata', () => {
    const context = Object.freeze({ id: 'reply', message_id: 'reply', provider_message_id: 'provider', custom: 'kept' })
    expect(withForwardedContext(context, { isForwarded: true })).toEqual({ ...context, forwarded: true })
    expect(context).not.toHaveProperty('forwarded')
    expect(withForwardedContext(undefined, { isForwarded: true })).toEqual({ forwarded: true })
  })
  const envelope = (message: object, group = false) => toUnoMessageEvent({
    key: { id: 'FORWARDED-PROVIDER-ID', fromMe: false, remoteJid: group ? '123@g.us' : '123@lid',
      remoteJidAlt: group ? undefined : '5511999999999@s.whatsapp.net',
      ...(group ? { participant: '123@lid', participantAlt: '5511999999999@s.whatsapp.net' } : {}) },
    timestampSeconds: 1790000000, message,
  } as never)
  const convert = (message: object, group = false) => fromBaileysMessageContent('5511888888888', envelope(message, group) as never)[0].entry[0].changes[0].value
  test.each([
    { extendedTextMessage: { text: 'Mensagem recebida', contextInfo: { isForwarded: true } } },
    { imageMessage: { url: 'https://example.test/a.jpg', mimetype: 'image/jpeg', contextInfo: { isForwarded: true } } },
    { audioMessage: { url: 'https://example.test/a.ogg', mimetype: 'audio/ogg', contextInfo: { isForwarded: true } } },
    { videoMessage: { url: 'https://example.test/a.mp4', mimetype: 'video/mp4', contextInfo: { isForwarded: true } } },
    { documentMessage: { url: 'https://example.test/a.pdf', mimetype: 'application/pdf', fileName: 'a.pdf', contextInfo: { isForwarded: true } } },
    { locationMessage: { degreesLatitude: -12, degreesLongitude: -55, contextInfo: { isForwarded: true } } },
    { ephemeralMessage: { message: { extendedTextMessage: { text: 'Efêmera', contextInfo: { isForwarded: true } } } } },
    { viewOnceMessageV2: { message: { imageMessage: { url: 'https://example.test/a.jpg', mimetype: 'image/jpeg', contextInfo: { isForwarded: true } } } } },
  ])('maps forwarding metadata after normalizing message/wrapper %p', content => {
    expect(convert(content).messages[0].context).toEqual({ forwarded: true })
  })
  test('preserves the quote reference and keeps forwarding inside context, not text', () => {
    const value = convert({ extendedTextMessage: { text: 'Mensagem recebida', contextInfo: { isForwarded: true, forwardingScore: 999, stanzaId: 'quoted-id' } } })
    expect(value.messages[0].context).toEqual({ id: 'quoted-id', message_id: 'quoted-id', forwarded: true })
    expect(value.messages[0].text.body).toBe('Mensagem recebida')
    expect(value.messages[0]).not.toHaveProperty('forwardingScore')
    expect(value.messages[0].context).not.toHaveProperty('frequently_forwarded')
  })
  test('preserves group routing', () => {
    const message = convert({ extendedTextMessage: { text: 'Grupo', contextInfo: { isForwarded: true } } }, true).messages[0]
    expect(message.group_id).toBe('123@g.us')
    expect(message.context.forwarded).toBe(true)
  })
  test('does not create empty context or mark ordinary messages as forwarded', () => {
    expect(convert({ conversation: 'Normal' }).messages[0]).not.toHaveProperty('context')
    expect(convert({ extendedTextMessage: { text: 'Normal', contextInfo: { isForwarded: false, forwardingScore: 99 } } }).messages[0]).not.toHaveProperty('context')
  })
  test('does not inherit forwarding from the quoted message', () => {
    const value = convert({ extendedTextMessage: { text: 'Resposta', contextInfo: {
      stanzaId: 'quoted-id', quotedMessage: { extendedTextMessage: { text: 'Encaminhada', contextInfo: { isForwarded: true } } },
    } } })
    expect(value.messages[0].context).toEqual({ id: 'quoted-id', message_id: 'quoted-id' })
  })
  test('does not add forwarding metadata to delivery statuses', () => {
    const payload = { ...envelope({}), update: { status: 'DELIVERY_ACK' }, key: { ...envelope({}).key, fromMe: true } }
    const value = fromBaileysMessageContent('5511888888888', payload as never)[0].entry[0].changes[0].value
    expect(value.messages).toHaveLength(0)
    expect(value.statuses[0]).not.toHaveProperty('context')
  })
})
