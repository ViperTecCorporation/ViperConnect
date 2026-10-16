import { addProviderMessageIds, removeProviderMessageIds } from '../../src/services/messages/provider_message_identity'

describe('provider message webhook identity', () => {
  test('removes only protocol aliases for all Typebot entries, preserving operational IDs', () => {
    const item = { id: 'uno', provider_message_id: 'protocol', context: { id: 'target', provider_message_id: 'original' },
      reaction: { message_id: 'target', provider_message_id: 'original' }, image: { id: 'session/uno' } }
    const payload = { entry: [{ changes: [{ value: { messages: [structuredClone(item)] } },
      { value: { message_echoes: [structuredClone(item)], statuses: [structuredClone(item)] } }] }] }
    removeProviderMessageIds(payload)
    expect(JSON.stringify(payload)).not.toContain('provider_message_id')
    expect(payload.entry[0].changes[0].value.messages[0]).toEqual({ id: 'uno', context: { id: 'target' },
      reaction: { message_id: 'target' }, image: { id: 'session/uno' } })
    expect(item.provider_message_id).toBe('protocol')
    expect(() => removeProviderMessageIds(undefined)).not.toThrow()
    expect(() => removeProviderMessageIds({ entry: [{ changes: [{}] }] })).not.toThrow()
  })
  test('adds aliases across messages, echoes, statuses and references without changing public IDs', () => {
    const message = { id: 'uno', context: { id: 'quoted', message_id: 'quoted' }, reaction: { message_id: 'quoted' }, image: { id: 'session/uno' } }
    const echo = { id: 'uno', context: { message_id: 'quoted' } }
    const status = { id: 'uno', status: 'read' }
    const payload = { entry: [{ changes: [{ value: { messages: [message], message_echoes: [echo], statuses: [status] } }] }] }
    addProviderMessageIds(payload, new Map([['uno', '3EB0EVENT'], ['quoted', '3EB0TARGET']]))
    expect(message).toEqual({ id: 'uno', provider_message_id: '3EB0EVENT',
      context: { id: 'quoted', message_id: 'quoted', provider_message_id: '3EB0TARGET' },
      reaction: { message_id: 'quoted', provider_message_id: '3EB0TARGET' }, image: { id: 'session/uno' } })
    expect(echo).toMatchObject({ id: 'uno', provider_message_id: '3EB0EVENT', context: { message_id: 'quoted', provider_message_id: '3EB0TARGET' } })
    expect(status).toEqual({ id: 'uno', status: 'read', provider_message_id: '3EB0EVENT' })
  })

  test('does not invent identities for old events, absent mappings or unrelated fields', () => {
    const payload = { entry: [{ changes: [{ value: { messages: [{ id: 'old', context: { id: 'missing' } }], statuses: [{ id: 'missing' }] } }] }] }
    const before = JSON.stringify(payload)
    addProviderMessageIds(payload, new Map())
    expect(JSON.stringify(payload)).toBe(before)
    expect(() => addProviderMessageIds(undefined, new Map())).not.toThrow()
  })
})
