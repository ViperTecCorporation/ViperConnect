import { outgoingEditWebhook } from '../../src/services/messages/outgoing_edit_webhook'

describe('outgoing edit webhook contract', () => {
  test.each([
    { context: { message_id: 'original' } },
    { context: { id: 'original' } },
    { edit: { message_id: 'original' } },
    { edit: { messageId: 'original' } },
    { message_id: 'original' },
  ])('matches original-ID aliases accepted by the sender: %j', reference => {
    const payload = { type: 'message_edit', text: { body: 'Texto corrigido' }, ...reference }
    const before = JSON.stringify(payload)
    expect(outgoingEditWebhook(payload, '1789859012')).toEqual({
      type: 'text', text: { body: 'Texto corrigido' }, message_type: 'message_edit',
      context: { id: 'original', message_id: 'original' }, edit_timestamp: 1789859012000,
    })
    expect(JSON.stringify(payload)).toBe(before)
  })
  test('prefers context.message_id over fallback IDs', () => {
    expect(outgoingEditWebhook({ type: 'message_edit', text: { body: 'x' },
      context: { message_id: 'original', id: 'other' }, message_id: 'event',
    }, '1')).toHaveProperty('context.message_id', 'original')
  })
  test.each(['text', 'reaction', 'interactive', 'image'])('does not alter %s', type => {
    expect(outgoingEditWebhook({ type }, '1')).toEqual({})
  })
})
