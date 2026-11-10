import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('web relay port follows mobile-primary and personal/business profiles, never default', () => {
  const source = readFileSync(new URL('../src/services/client_zapo.ts', import.meta.url), 'utf8')
  const expression = source.match(/preferWebRelayPort: ([\s\S]*?),\s*\}\)\]/)?.[1]
  assert.ok(expression, 'policy must remain explicitly configured on voipPlugin')
  const policy = new Function('process', `return (${expression})`)
  for (const mobilePrimaryDraftId of ['', 'device-id']) {
    for (const zapoWebClientProfile of [undefined, 'default', 'wa_personal', 'wa_business']) {
      for (const server of [undefined, 'server_1', 'mobile_lab']) {
        assert.equal(policy.call({ config: { mobilePrimaryDraftId, zapoWebClientProfile } }, {
          env: { UNOAPI_SERVER_NAME: server },
        }), !!mobilePrimaryDraftId || ['wa_personal', 'wa_business'].includes(zapoWebClientProfile))
      }
    }
  }
})
