import { providerFromQueueName, providerQueueName } from '../../src/services/providers/provider_queue'

describe('provider queue', () => {
  test('builds an isolated Baileys worker queue by default', () => {
    expect(providerQueueName('unoapi.incoming', 'server_1', undefined)).toBe('unoapi.incoming.server_1.baileys')
  })

  test('builds an isolated Zapo worker queue', () => {
    expect(providerQueueName('unoapi.incoming', 'server_1', 'zapo')).toBe('unoapi.incoming.server_1.zapo')
  })

  test('extracts only supported engines from a queue name', () => {
    expect(providerFromQueueName('unoapi.incoming.server_1.zapo')).toBe('zapo')
    expect(providerFromQueueName('unoapi.incoming.server_1')).toBeUndefined()
  })
})
