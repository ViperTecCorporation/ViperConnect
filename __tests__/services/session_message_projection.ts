import { proto, type WaStoredMessageRecord } from 'zapo-js'
import { conversationJid, projectSessionMessage } from '../../src/services/messages/session_message_projection'

const record = (message: any): WaStoredMessageRecord => ({ id: 'ABC', threadJid: '123@lid', fromMe: false, timestampMs: 100, messageBytes: proto.Message.encode(message).finish() })
describe('session message safe projection', () => {
  test.each(['123@lid', '5511999999999@s.whatsapp.net', '120363123@g.us', '123-456@g.us'])('accepts cached conversation %s', jid => expect(conversationJid(jid)).toBe(true))
  test.each(['status@broadcast', '123@newsletter', '../secret', '*@lid', '123@broadcast'])('excludes %s', jid => expect(conversationJid(jid)).toBe(false))
  test('text, direction, group participant and quote use bounded public fields', () => {
    const dto = projectSessionMessage({ ...record({ extendedTextMessage: { text: 'hello', contextInfo: { stanzaId: 'parent', quotedMessage: { conversation: 'secret quote body' } } } }), fromMe: true, participantJid: '456@lid' })
    expect(dto).toMatchObject({ text: 'hello', type: 'text', from_me: true, sender: '456@lid', reply_to: 'parent' })
    expect(dto.reply_preview).toMatchObject({ text: 'secret quote body', id: 'parent', available: false })
  })
  test.each(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'])('never exposes %s media or caption', wrapper => {
    const dto = projectSessionMessage(record({ ephemeralMessage: { message: { [wrapper]: { message: { imageMessage: { caption: 'private caption', url: 'https://mmg.whatsapp.net/secret', mediaKey: new Uint8Array([1, 2, 3]) } } } } } }))
    expect(dto.type).toBe('view_once'); expect(dto.media).toBeUndefined()
    expect(JSON.stringify(dto)).not.toMatch(/caption|mmg|mediaKey/)
  })
  test.each(['image', 'video', 'audio', 'document', 'sticker'])('projects %s without keys or URL', type => {
    const dto = projectSessionMessage(record({ [type + 'Message']: { mimetype: 'image/jpeg', fileName: 'photo.jpg', mediaKey: new Uint8Array([1]), url: 'https://private.example' } }))
    expect(dto.type).toBe(type); expect(dto.media?.mime_type).toBe('image/jpeg')
    expect(JSON.stringify(dto)).not.toMatch(/mediaKey|private.example/)
  })
  test.each([{ contactMessage: { displayName: 'Ana' } }, { contactsArrayMessage: { displayName: 'Contacts' } }, { locationMessage: { name: 'Store', degreesLatitude: -1, degreesLongitude: 2 } }, { interactiveMessage: { body: { text: 'Choose' } } }])('renders supported non-text content %j', message => {
    expect(projectSessionMessage(record(message)).type).not.toBe('unsupported')
  })
  test('revokes show a notice', () => expect(projectSessionMessage(record({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } })).type).toBe('revoked'))
  test('unknown/malformed bodies are safe', () => {
    expect(projectSessionMessage({ ...record({}), messageBytes: new Uint8Array([255]) }).type).toBe('unsupported')
    expect(projectSessionMessage({ id: 'x', threadJid: '123@lid', fromMe: false }).type).toBe('unsupported')
  })
  test('bounds text length', () => expect(projectSessionMessage(record({ conversation: 'x'.repeat(17000) })).text).toHaveLength(16000))
  test('quoted view-once media never reveals captions or media references', () => {
    const dto = projectSessionMessage(record({ extendedTextMessage: { text: 'Reply', contextInfo: { stanzaId: 'original', quotedMessage: { viewOnceMessageV2: { message: { imageMessage: { caption: 'private quoted caption' } } } } } } }))
    expect(dto.reply_preview?.type).toBe('view_once')
    expect(JSON.stringify(dto.reply_preview)).not.toContain('private quoted caption')
  })
  test('contact cards expose only bounded names and phone numbers', () => {
    const dto = projectSessionMessage(record({ contactMessage: { displayName: 'Ana', vcard: 'BEGIN:VCARD\nTEL;TYPE=CELL:+55 (11) 99999-9999\nEMAIL:private@example.com\nEND:VCARD' } }))
    expect(dto.contacts).toEqual([{ name: 'Ana', phones: ['+5511999999999'] }])
    expect(JSON.stringify(dto)).not.toContain('private@example.com')
  })
  test.each(['javascript:alert(1)', 'https://user:password@example.com', 'file:///secret'])('never exposes unsafe CTA %s', url => {
    const dto = projectSessionMessage(record({ interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Open', url }) }] } } }))
    expect(dto.buttons).toEqual([{ label: 'Open' }])
  })
  test('projects public CTA and handles malformed button parameters', () => {
    const dto = projectSessionMessage(record({ interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: '{"display_text":"Open","url":"https://example.com"}' }, { buttonParamsJson: '{' }] } } }))
    expect(dto.buttons).toEqual([{ label: 'Open', url: 'https://example.com/' }, { label: 'Mensagem interativa' }])
  })
})
