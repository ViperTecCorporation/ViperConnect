'use strict'
const assert = require('node:assert/strict')
const { randomBytes, randomInt } = require('node:crypto')
const { createClient } = require('@redis/client')
const { MobileDeviceService } = require('../../dist/src/services/mobile_device_service.js')
const { MobileRegistrationService, REGISTRATION_PREFIX } = require('../../dist/src/services/mobile_primary/registration_service.js')
const { RegistrationVault } = require('../../dist/src/services/mobile_primary/registration_vault.js')
const { createNewStore, storeToJson } = require('/opt/mobile-registration/node_modules/whalibmob/lib/Store.js')

async function main() {
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
  assert.equal(process.env.MOBILE_REGISTRATION_ENABLED, 'false')
  const redis = createClient({ url: process.env.REDIS_URL })
  await redis.connect()
  const drafts = new MobileDeviceService(async () => redis)
  let draft
  try {
    process.env.WA_OS = 'android'; process.env.WA_BUSINESS = '0'
    draft = await drafts.create({ phone: `999${randomInt(100000000, 999999999)}`, name: 'Offline Redis smoke', platform: 'android', accountType: 'personal', labConsent: true }, 'offline-smoke')
    let requests = 0
    const provider = async input => {
      if (input.action === 'prepare') return { store: storeToJson(createNewStore(input.draft.phone, { name: 'Offline smoke' })) }
      if (input.action === 'request') { requests++; return { store: { ...input.store, codePending: true } } }
      return { store: { ...input.store, registered: true, codePending: false } }
    }
    const service = new MobileRegistrationService(drafts, async () => redis, () => vault, provider, () => true)
    const vault = new RegistrationVault(randomBytes(32).toString('hex'))
    const results = await Promise.allSettled([service.execute(draft.id, 'request', { confirm: true }), service.execute(draft.id, 'request', { confirm: true })])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(requests, 1)
    await assert.rejects(drafts.remove(draft.id), error => error.status === 409)
    const result = await service.execute(draft.id, 'verify', { code: '012345' })
    assert.equal(result.status, 'registered')
    const raw = await redis.get(REGISTRATION_PREFIX + draft.id)
    assert.ok(raw.startsWith('v1.')); assert.ok(!raw.includes('012345'))
    console.log('OK: Redis real, CAS concorrente, estado cifrado, exclusão protegida e confirmação simulada. Sem SMS/rede WhatsApp.')
  } finally {
    if (draft) {
      await redis.del(REGISTRATION_PREFIX + draft.id)
      await drafts.remove(draft.id)
      console.log('OK: removidos somente os dados fictícios criados por este smoke.')
    }
    await redis.quit()
  }
}
main().catch(() => { console.error('Falha no smoke local; detalhes sensíveis não impressos.'); process.exitCode = 1 })
