import { ContactIncoming } from '../../src/services/contact_incoming'
import type { Incoming } from '../../src/services/incoming'

describe('ContactIncoming', () => {
  test('delegates contact verification to the selected provider', async () => {
    const contacts = jest.fn().mockResolvedValue([{ input: '5566', wa_id: '5566@s.whatsapp.net', status: 'valid' }])
    const service = new ContactIncoming({ contacts } as unknown as Incoming)
    await expect(service.verify('session', ['5566'], undefined)).resolves.toEqual({ contacts: await contacts.mock.results[0]?.value })
    expect(contacts).toHaveBeenCalledWith('session', ['5566'])
  })

  test('posts the provider result to the optional webhook', async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never
    try {
      const service = new ContactIncoming({ contacts: jest.fn().mockResolvedValue([]) } as unknown as Incoming)
      await service.verify('session', [], 'https://example.test/contact')
      expect(global.fetch).toHaveBeenCalledWith('https://example.test/contact', expect.objectContaining({ method: 'POST' }))
    } finally {
      global.fetch = originalFetch
    }
  })

  test('fails explicitly when the provider operation is unavailable', async () => {
    await expect(new ContactIncoming({} as Incoming).verify('session', [], undefined)).rejects.toThrow('does not support')
  })
})
