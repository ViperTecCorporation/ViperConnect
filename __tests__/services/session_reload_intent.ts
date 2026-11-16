import { isDeepStrictEqual } from 'node:util'
import { defaultConfig } from '../../src/services/config'
import { sessionReloadIntent } from '../../src/services/session_reload_intent'

test('reload identity ignores recreated runtime functions and JSON property order', () => {
  const first = { ...defaultConfig, getStore: jest.fn(), webhooks: [{ id: 'a', enabled: true }] }
  const next = { ...defaultConfig, getStore: jest.fn(), webhooks: [{ enabled: true, id: 'a' }] }
  expect(isDeepStrictEqual(sessionReloadIntent(first as any), sessionReloadIntent(next as any))).toBe(true)
})

test.each(['autoConnect', 'server', 'provider', 'proxyUrl', 'connectionType', 'zapoWebClientProfile', 'sessionStorage'])('reload identity preserves a real %s intent change', key => {
  const first = { ...defaultConfig, autoConnect: false }
  const next = { ...first, [key]: key === 'autoConnect' ? true : key === 'sessionStorage' ? { backend: 'sqlite', generation: 2 } : 'changed' }
  expect(isDeepStrictEqual(sessionReloadIntent(first), sessionReloadIntent(next as any))).toBe(false)
})
