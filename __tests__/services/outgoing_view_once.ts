import { outgoingViewOnce, outgoingViewOnceWebhook } from '../../src/services/messages/outgoing_view_once'

test.each(['image', 'video', 'audio'])('accepts optional boolean for %s and marks only true echoes', type => {
  for (const value of [true, false, undefined]) {
    const payload = { type, [type]: { view_once: value } }
    expect(outgoingViewOnce(payload)).toBe(value)
    expect(outgoingViewOnceWebhook(payload)).toEqual(value === true ? { message_type: 'view_once' } : {})
  }
})
test.each(['true', 'false', 1, 0, null, {}, []])('rejects non-boolean %j', view_once => {
  expect(() => outgoingViewOnce({ type: 'image', image: { view_once } })).toThrow('view_once_must_be_boolean')
})
test.each(['text', 'document', 'sticker', 'location', 'contacts'])('rejects unsupported %s', type => {
  expect(() => outgoingViewOnce({ type, [type]: { view_once: true } })).toThrow('view_once_unsupported_message_type')
})
test('does not silently accept a misplaced flag', () => {
  expect(() => outgoingViewOnce({ type: 'image', view_once: true })).toThrow('view_once_must_be_inside_media')
  expect(outgoingViewOnce({ type: 'text', text: { body: 'hello' } })).toBeUndefined()
})
