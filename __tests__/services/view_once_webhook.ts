import { fromBaileysMessageContent } from '../../src/services/transformer'
import { isViewOnceContent } from '../../src/services/transformer/view_once'

describe('view-once webhook metadata', () => {
  const media = (kind: string, flag?: boolean) => ({ [kind + 'Message']: {
    mimetype: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/ogg',
    url: 'https://example.test/media', ...(flag === undefined ? {} : { viewOnce: flag }),
  } })
  test.each(['image', 'video', 'audio'])('preserves %s flags and wrappers without Redis', kind => {
    const plain = media(kind)
    const variants = [media(kind, true), ...['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].map(wrapper => ({ [wrapper]: { message: plain } })),
      { ephemeralMessage: { message: { viewOnceMessageV2: { message: plain } } } },
      { deviceSentMessage: { message: media(kind, true) } }]
    for (const message of variants) {
      const input = { key: { id: 'original-id', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false }, message, messageTimestamp: 1790672409 }
      const before = JSON.stringify(input)
      const [webhook] = fromBaileysMessageContent('5511888888888', input)
      const messages = webhook.entry[0].changes[0].value.messages
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ id: 'original-id', type: kind, message_type: 'view_once' })
      expect(messages[0].edit_timestamp).toBeUndefined()
      expect(messages[0].context).toBeUndefined()
      expect(JSON.stringify(input)).toBe(before)
    }
  })
  test.each([undefined, false])('does not mark ordinary or ephemeral media (flag=%s)', flag => {
    for (const message of [media('image', flag), { ephemeralMessage: { message: media('image', flag) } }]) {
      const [webhook] = fromBaileysMessageContent('5511888888888', {
        key: { id: 'normal', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false }, message,
      })
      expect(webhook.entry[0].changes[0].value.messages[0].message_type).toBeUndefined()
    }
  })
  test('does not inspect quoted content or classify text and malformed wrappers', () => {
    expect(isViewOnceContent({ extendedTextMessage: { contextInfo: { quotedMessage: media('image', true) } } })).toBe(false)
    expect(isViewOnceContent({ viewOnceMessage: {} })).toBe(false)
    expect(isViewOnceContent(undefined)).toBe(false)
    const cyclic: any = {}; cyclic.ephemeralMessage = { message: cyclic }
    expect(isViewOnceContent(cyclic)).toBe(false)
  })
})
