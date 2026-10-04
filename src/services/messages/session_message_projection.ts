import { proto, type WaStoredMessageRecord } from 'zapo-js'

export const conversationJid = (value: string) => /^(?:\d+(?:-\d+)?@g\.us|\d+@(?:lid|s\.whatsapp\.net))$/.test(value)

// Only a public, bounded projection leaves the backend. Never expose media keys,
// encrypted CDN URLs, thumbnails, protocol secrets or the raw protobuf.
const quotePreview = (context: any): { id: string; text: string; type: string; sender?: string; available: boolean } => {
  const message = projectSessionMessage({ id: context.stanzaId, threadJid: '', fromMe: false, messageBytes: proto.Message.encode(context.quotedMessage).finish() }, false)
  return { id: `${context.stanzaId}`, text: message.text.slice(0, 180), type: message.type, sender: context.participant || undefined, available: false }
}

export const projectSessionMessage = (record: WaStoredMessageRecord, includeQuote = true) => {
  let content: any = {}
  try { if (record.messageBytes) content = proto.Message.decode(record.messageBytes) } catch {}
  let viewOnce = false
  for (let depth = 0; depth < 8; depth++) {
    const wrapper = content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension
    if (wrapper) { viewOnce = true; content = wrapper.message || {}; continue }
    const nested = content.ephemeralMessage || content.documentWithCaptionMessage
    if (!nested) break
    content = nested.message || {}
  }
  const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker']
  const mediaType = mediaTypes.find(type => content[`${type}Message`]) || (content.ptvMessage ? 'video' : undefined)
  const media = mediaType ? (content[`${mediaType}Message`] || content.ptvMessage) : undefined
  const context = (media || content.extendedTextMessage || content.contactMessage || content.contactsArrayMessage || content.locationMessage || content.interactiveMessage)?.contextInfo
  const protocol = content.protocolMessage
  const revoked = protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE
  const type = viewOnce ? 'view_once' : revoked ? 'revoked' : mediaType ||
    (content.conversation != null || content.extendedTextMessage ? 'text' :
      content.contactMessage || content.contactsArrayMessage ? 'contact' :
        content.locationMessage ? 'location' : content.interactiveMessage || content.listMessage || content.buttonsMessage ? 'interactive' : 'unsupported')
  let text = content.conversation || content.extendedTextMessage?.text || media?.caption || ''
  if (type === 'contact') text = content.contactMessage?.displayName || content.contactsArrayMessage?.displayName || 'Contato'
  if (type === 'location') text = [content.locationMessage?.name, content.locationMessage?.address].filter(Boolean).join(' · ')
  if (type === 'interactive') text = content.interactiveMessage?.body?.text || content.listMessage?.description || content.buttonsMessage?.contentText || 'Mensagem interativa'
  if (viewOnce) text = 'Mensagem de visualização única'
  if (revoked) text = 'Mensagem removida'
  const cards = content.contactsArrayMessage?.contacts || (content.contactMessage ? [content.contactMessage] : [])
  const contacts = cards.slice(0, 20).map((card: any) => ({ name: `${card.displayName || 'Contato'}`.slice(0, 200),
    phones: `${card.vcard || ''}`.split(/\r?\n/).filter((line: string) => /^TEL[;:]/i.test(line)).slice(0, 5).map((line: string) => line.slice(line.indexOf(':') + 1).replace(/[^+\d]/g, '').slice(0, 20)) }))
  const buttons = (content.interactiveMessage?.nativeFlowMessage?.buttons || []).slice(0, 10).map((button: any) => {
    try {
      const parameters = JSON.parse(`${button.buttonParamsJson || '{}'}`)
      const label = `${parameters.display_text || parameters.title || button.name || ''}`.slice(0, 100)
      let url: string | undefined
      if (button.name === 'cta_url' && typeof parameters.url === 'string' && parameters.url.length <= 2048) {
        const candidate = new URL(parameters.url)
        if (['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) url = candidate.href
      }
      return { label, ...(url ? { url } : {}) }
    } catch { return { label: 'Mensagem interativa' } }
  })
  return {
    id: record.id, conversation_id: record.threadJid, from_me: record.fromMe,
    sender: record.participantJid || record.senderJid, timestamp_ms: record.timestampMs || 0,
    type, text: `${text}`.slice(0, 16000),
    ...(media && !viewOnce ? { media: { mime_type: `${media.mimetype || ''}`, filename: `${media.fileName || ''}`.slice(0, 250), available: true } } : {}),
    ...(context?.stanzaId ? { reply_to: `${context.stanzaId}` } : {}),
    ...(includeQuote && context?.stanzaId && context?.quotedMessage && !viewOnce ? { reply_preview: quotePreview(context) } : {}),
    ...(!viewOnce && contacts.length ? { contacts } : {}),
    ...(!viewOnce && buttons.length ? { buttons } : {}),
    ...(type === 'location' ? { location: { latitude: content.locationMessage.degreesLatitude, longitude: content.locationMessage.degreesLongitude } } : {}),
  }
}

export type SessionMessage = ReturnType<typeof projectSessionMessage>
