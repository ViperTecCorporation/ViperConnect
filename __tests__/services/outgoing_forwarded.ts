import { outgoingForwarded, outgoingForwardedWebhook } from '../../src/services/messages/outgoing_forwarded'

describe('outgoing forwarding marker', () => {
  test.each(['text', 'image', 'video', 'audio', 'document', 'sticker', 'contacts', 'location'])('supports supplied %s content', type => {
    const payload = { type, context: { forwarded: true } }
    expect(outgoingForwarded(payload)).toBe(true)
    expect(outgoingForwardedWebhook(payload)).toEqual({ context: { forwarded: true } })
  })
  test.each([undefined, {}, { context: {} }, { context: { message_id: 'quote' } }, { type: 'text', context: { forwarded: false } }])('does not mark normal sends %p', payload => {
    expect(outgoingForwardedWebhook(payload)).toEqual({})
  })
  test.each(['true', 1, null, {}])('rejects non-boolean marker %p', forwarded => {
    expect(() => outgoingForwarded({ type: 'text', context: { forwarded } })).toThrow('400: forwarded_must_be_boolean')
  })
  test.each(['reaction', 'message_edit', 'poll', 'poll_vote', 'interactive', 'template', 'raw'])('rejects unsupported %s', type => {
    expect(() => outgoingForwarded({ type, context: { forwarded: true } })).toThrow('400: forwarded_unsupported_message_type')
  })
  test('rejects statuses and Status broadcast', () => {
    expect(() => outgoingForwarded({ type: 'text', status: 'read', context: { forwarded: true } })).toThrow('400:')
    expect(() => outgoingForwarded({ type: 'image', to: 'status@broadcast', context: { forwarded: true } })).toThrow('400:')
  })
})
