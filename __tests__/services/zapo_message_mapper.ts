import { toZapoMessageContent } from '../../src/services/zapo/zapo_message_mapper'
import { mockDeep } from 'jest-mock-extended'
import type { WaClient } from 'zapo-js'

describe('Zapo message mapper', () => {
  const client = mockDeep<WaClient>()

  test('maps text and mentions to the documented typed Zapo content', async () => {
    await expect(toZapoMessageContent(client, {
      type: 'text',
      text: { body: 'Oi @556699999999' },
    }, (text) => `${text}!`)).resolves.toEqual({
      content: { type: 'text', text: 'Oi @556699999999!' },
      options: { mentions: ['556699999999@s.whatsapp.net'] },
    })
  })

  test('maps every supported media family without downloading it in the mapper', async () => {
    for (const type of ['image', 'audio', 'document', 'video', 'sticker']) {
      const mapped = await toZapoMessageContent(client, {
        type,
        [type]: { link: `https://example.test/${type}`, mime_type: 'application/octet-stream', caption: 'Legenda' },
      })
      expect(mapped.content).toEqual(expect.objectContaining({ type, media: `https://example.test/${type}` }))
    }
  })

  test('maps voice-note audio to the Zapo ptt media type', async () => {
    await expect(toZapoMessageContent(client, { type: 'audio', audio: { link: 'https://example.test/a.ogg', ptt: true } }))
      .resolves.toEqual(expect.objectContaining({ content: expect.objectContaining({ type: 'ptt' }) }))
  })

  test('rejects media without a link', async () => {
    await expect(toZapoMessageContent(client, { type: 'image', image: {} })).rejects.toThrow('invalid_image_payload')
  })

  test('passes raw protocol messages through for advanced compatibility', async () => {
    const message = { conversation: 'raw' }
    await expect(toZapoMessageContent(client, { type: 'baileys', message })).resolves.toEqual({ content: message, options: {} })
  })

  test('rejects message types without a documented mapping', async () => {
    await expect(toZapoMessageContent(client, { type: 'unknown' })).rejects.toThrow('unsupported_zapo_message_type')
  })
})
