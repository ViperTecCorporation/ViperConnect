import { remainingMobileWebhooks, mergeMobileWebhooks } from '../../src/services/mobile_primary/integration_policy'

describe('mobile integration webhook selection', () => {
  const hooks = [{ id: 'a', url: 'https://example.test/a' }, { id: 'b', url: 'https://example.test/b' }]
  test('accepts ViperChat urlAbsolute for registration and exact removal', () => {
    const hook = { id: 'viperchat', urlAbsolute: 'https://example.test/webhooks/whatsapp/inbox' }
    expect(mergeMobileWebhooks(hooks, [hook])).toEqual([...hooks, hook])
    expect(remainingMobileWebhooks([hook], { webhooks: [hook] })).toEqual([])
    expect(remainingMobileWebhooks([hook], { webhooks: [{ url: hook.urlAbsolute }] })).toEqual([])
    expect(remainingMobileWebhooks([hook], { webhooks: [{ urlAbsolute: hook.urlAbsolute }] })).toEqual([])
  })
  test('register adds and updates destinations without removing another integration', () => {
    expect(mergeMobileWebhooks(hooks, [{ id: 'a', url: 'https://new.test/a' }, { id: 'c', url: 'https://new.test/c' }])).toEqual([{ id: 'a', url: 'https://new.test/a' }, hooks[1], { id: 'c', url: 'https://new.test/c' }])
    expect(mergeMobileWebhooks(hooks, [])).toEqual(hooks)
    expect(() => mergeMobileWebhooks(hooks, [{}])).toThrow('mobile_webhooks_invalid')
    expect(() => mergeMobileWebhooks(hooks, null)).toThrow('mobile_webhooks_invalid')
  })
  test('removes exact identities and preserves other paths on the same domain', () => {
    expect(remainingMobileWebhooks(hooks, { webhooks: [{ id: 'a' }] })).toEqual([hooks[1]])
    expect(remainingMobileWebhooks(hooks, { webhooks: [{ url: hooks[0].url }] })).toEqual([hooks[1]])
    expect(remainingMobileWebhooks(hooks, { webhooks: hooks })).toEqual([])
    expect(remainingMobileWebhooks([hooks[1]], { webhooks: [{ id: 'a' }] })).toEqual([hooks[1]])
    expect(hooks).toHaveLength(2)
  })
  test.each([undefined, {}, { webhooks: [] }, { webhooks: [null] }, { webhooks: [{}] }, { webhooks: ['example.test'] }])('rejects malformed body %j', body => {
    expect(() => remainingMobileWebhooks(hooks, body)).toThrow()
  })
  test('rejects ambiguous and inconsistent selectors', () => {
    expect(() => remainingMobileWebhooks([hooks[0], hooks[0]], { webhooks: [{ id: 'a' }] })).toThrow('mobile_webhook_selector_ambiguous')
    expect(() => remainingMobileWebhooks(hooks, { webhooks: [{ id: 'a', url: hooks[1].url }] })).toThrow('mobile_webhook_selector_mismatch')
  })
})
