import { composerPayload, mergeConversationMessages, type ConversationMessage } from '../../frontend/domain/session_messages'
import { conversationCard, conversationAvatar, deliveryStatus, messageBubble } from '../../frontend/features/session_messages_render'
import { renderSessionPage } from '../../frontend/pages/session'

const message = (id: string, timestamp_ms = 1): ConversationMessage => ({ id, timestamp_ms, from_me: false, conversation_id: '123@lid', text: 'hello', type: 'text' })
describe('Messages panel contracts', () => {
  test('group bubbles and quotes display escaped contact names instead of LIDs', () => {
    const html = messageBubble({ ...message('a'), conversation_id: '123@g.us', sender: '456@lid', sender_name: '<Ana>', reply_to: 'b', reply_preview: { id: 'b', text: 'Original', type: 'text', sender: '789@lid', sender_name: 'Bruno', available: true } })
    expect(html).toContain('&lt;Ana&gt;')
    expect(html).toContain('Resposta · Bruno')
    expect(html).not.toContain('456@lid')
    expect(html).not.toContain('789@lid')
    expect(messageBubble({ ...message('a'), conversation_id: '123@g.us', sender: '456@lid' })).toContain('456@lid')
  })
  test('checks distinguish read/delivered/sent and unknown explicitly', () => {
    expect(deliveryStatus('read')).toContain('is-read'); expect(deliveryStatus('delivered')).toContain('Entregue')
    expect(deliveryStatus('sent')).toContain('Enviada'); expect(deliveryStatus()).toContain('Confirmação indisponível')
  })
  test('only authenticated blob avatars are rendered and quotes are clickable previews', () => {
    const contact = { id: '123@lid', name: 'Ana', kind: 'direct' as const, preview: '', timestamp_ms: 0, last_message_id: '', type: 'text' }
    expect(conversationAvatar({ ...contact, picture: 'blob:safe' })).toContain('<img')
    expect(conversationAvatar({ ...contact, picture: 'javascript:bad' })).not.toContain('<img')
    expect(messageBubble({ ...message('a'), reply_to: 'original', reply_preview: { id: 'original', text: '<unsafe>original', type: 'text', available: true } })).toContain('data-chat="jump"')
    expect(messageBubble({ ...message('a'), reply_to: 'original', reply_preview: { id: 'original', text: '<unsafe>', type: 'text', available: true } })).not.toContain('<unsafe>')
  })
  test('tab label is Mensagens next to Grupos', () => {
    const html = renderSessionPage({ session: { phone: '5511999999999' } as any, tab: 'messages', contacts: [], contactsHasMore: false, contactCount: 0, contactsQuery: '', groups: [], groupsHasMore: false, groupsQuery: '', loadingSection: false, sectionError: '', messagesHtml: '<div>chat fixture</div>' })
    expect(html).toContain('data-tab="messages"'); expect(html).toContain('chat fixture')
    expect(html.indexOf('data-tab="groups"')).toBeLessThan(html.indexOf('data-tab="messages"'))
  })
  test('text and attachment replies use existing send contract', () => {
    expect(composerPayload('5511999999999', 'hello', 'original')).toMatchObject({ to: '5511999999999', type: 'text', context: { message_id: 'original' }, text: { body: 'hello' } })
    expect(composerPayload('123@lid', 'caption', undefined, { type: 'image', base64: 'data:image/png;base64,AAAA', mime: 'image/png', filename: 'x.png' })).toMatchObject({ type: 'image', image: { caption: 'caption', mime_type: 'image/png', filename: 'x.png' } })
    expect(composerPayload('123@g.us', '', undefined, { type: 'audio', base64: 'AAAA', mime: 'audio/mpeg', filename: 'x.mp3' })).not.toHaveProperty('audio.caption')
  })
  test('validates recipient, empty message and text limits', () => {
    expect(() => composerPayload('../secret', 'hello')).toThrow()
    expect(() => composerPayload('123@lid', ' ')).toThrow()
    expect(() => composerPayload('123@lid', 'x'.repeat(16001))).toThrow()
  })
  test('merges edits without duplicate IDs and caps memory at 500', () => {
    expect(mergeConversationMessages([message('a')], [{ ...message('a'), text: 'edited' }])).toHaveLength(1)
    const previous = Array.from({ length: 510 }, (_, i) => message(String(i), i))
    expect(mergeConversationMessages([], previous)).toHaveLength(500)
    expect(mergeConversationMessages([], previous, true)[0].timestamp_ms).toBe(0)
    expect(mergeConversationMessages([], previous)[0].timestamp_ms).toBe(10)
  })
  test('escapes content and never renders view-once/revoked media', () => {
    expect(messageBubble({ ...message('a'), text: '<script>danger</script>' })).not.toContain('<script>')
    for (const type of ['view_once', 'revoked']) expect(messageBubble({ ...message('a'), type, media: { mime_type: 'image/png', filename: 'secret', available: true } }, 'blob:secret')).not.toContain('blob:secret')
  })
  test.each(['image/png', 'video/mp4', 'audio/mpeg', 'text/html'])('renders safe lazy %s', mime => {
    const dto = { ...message('a'), media: { mime_type: mime, filename: '<file>', available: true } }
    expect(messageBubble(dto)).toContain('data-chat="media"')
    const html = messageBubble(dto, 'blob:test')
    expect(html).toContain('blob:test')
    if (mime === 'text/html') { expect(html).toContain('download='); expect(html).not.toContain('<iframe') }
  })
  test('sidebar escapes names and previews', () => expect(conversationCard({ id: '123@lid', name: '<script>', preview: '<img>', timestamp_ms: 1, last_message_id: 'a', kind: 'direct', type: 'text' }, '')).not.toContain('<script>'))
})
