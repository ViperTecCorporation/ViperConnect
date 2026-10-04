// Synthetic Redis/HTTP contract test. Never connects to WhatsApp or registers a real phone.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const Redis = require('ioredis')
const { WaAuthRedisStore, WaMessageRedisStore } = require('@zapo-js/store-redis')
const { X25519, xeddsaSign } = require('zapo-js/crypto')
const { convertWhalibmobCredentials } = require('/app/dist/src/services/mobile_primary/whalibmob_credentials.js')
const { decryptMobileBackup } = require('/app/dist/src/services/mobile_primary/backup_archive.js')
const { createZapoStore } = require('/app/dist/src/services/zapo/zapo_store.js')
const { clearZapoSession } = require('/app/dist/src/services/zapo/zapo_session_cleanup.js')
async function main() {
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  const redis = new Redis(process.env.REDIS_URL), phone = '999' + String(Date.now()).slice(-11), password = randomBytes(24).toString('hex')
  const configKey = 'unoapi-config:' + phone, checkpoint = 'session-transfer:{v1}:completed:' + phone, taskKey = 'session-transfer:{v1}:task:' + phone
  const unoKey = 'unoapi-id:' + phone + ':fixture'
  const api = async (path, body, method = 'POST', authenticated = true) => {
    const response = await fetch('http://127.0.0.1:9876/manager/session-transfers' + path, { method, headers: { ...(authenticated ? { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text(); let result; try { result = JSON.parse(text) } catch {}
    return { status: response.status, result }
  }
  let owned = false
  try {
    assert.equal(await redis.exists(configKey, 'unoapi:zapo:auth:' + phone, unoKey), 0)
    owned = true
    const pair = async () => { const p = await X25519.generateKeyPair(); return { private: Buffer.from(p.privKey).toString('base64'), public: Buffer.concat([Buffer.from([5]), p.pubKey]).toString('base64') } }
    const identity = await pair(), signed = await pair()
    const store = { phoneNumber: phone, registered: true, codePending: false, noiseKeyPair: await pair(), identityKeyPair: identity, signedPreKey: { ...signed, id: 17, signature: Buffer.from(await xeddsaSign(Buffer.from(identity.private, 'base64'), Buffer.from(signed.public, 'base64'))).toString('base64') }, registrationId: 100, name: 'Synthetic', version: '2.26.27.70', device: { os: 'android', business: false, manufacturer: 'Samsung', model: 'Galaxy', modelId: 'SM-S928B', osVersion: '14', osBuildNumber: 'UP1A' } }
    const credentials = await convertWhalibmobCredentials(store, { expectedCanonicalPhone: phone, advSecretKey: randomBytes(32) })
    delete credentials.deviceInfo; credentials.meJid = phone + ':3@s.whatsapp.net'
    const options = { redis, keyPrefix: 'unoapi:zapo:', sessionId: phone }
    const auth = new WaAuthRedisStore(options), messages = new WaMessageRedisStore(options)
    await auth.save(credentials)
    await messages.upsert({ id: 'fixture', threadJid: '123@lid', fromMe: false, timestampMs: Date.now(), messageBytes: Buffer.from([10, 2, 111, 105]) })
    await redis.set(unoKey, 'uno-fixture', 'PX', 120000)
    await redis.set(configKey, JSON.stringify({ provider: 'zapo', server: 'mobile_lab', name: 'Synthetic transfer', useRedis: true, useS3: true, autoConnect: false, webhooks: [] }))
    assert.equal((await api('/backups', undefined, 'GET', false)).status, 401)
    const consent = { phone, confirm: true, backupValidated: true, password: process.env.UNOAPI_AUTH_TOKEN }
    assert.equal((await api('/' + phone + '/transfer-removal', consent, 'DELETE')).status, 409)
    const accepted = await api('/' + phone + '/backup-tasks', { password, confirmSuspend: true, mode: 'complete' })
    assert.equal(accepted.status, 202)
    let state
    for (let i = 0; i < 100; i++) {
      state = (await api('/backups', undefined, 'GET')).result.tasks.find(t => t.id === accepted.result.id)
      if (state?.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.equal(state?.status, 'ready', 'Export status: ' + state?.error)
    const exported = await api('/' + phone + '/backup-tasks/' + state.id + '/download', undefined, 'GET')
    assert.equal(exported.status, 200)
    assert.ok(exported.result.fileName.endsWith('.vipersession'))
    const snapshot = await decryptMobileBackup(exported.result.archive, password)
    assert.equal(snapshot.kind, 'linked-session')
    assert.ok(snapshot.records.some(r => r.namespace === 'uno'))
    assert.ok(!JSON.stringify(await api('/backups', undefined, 'GET')).includes(password))
    const restore = { archive: exported.result.archive, password, confirmOriginOffline: true }
    assert.equal((await api('/restore', restore)).status, 409)
    assert.equal((await api('/restore', { ...restore, password: 'incorrect-password' })).status, 400)
    assert.equal((await api('/' + phone + '/transfer-removal', consent, 'DELETE')).status, 204)
    assert.equal(await redis.exists(configKey, 'unoapi:zapo:auth:' + phone), 0)
    // Existing Uno data prevents a destructive restore. Clear this exact test fixture only.
    assert.equal((await api('/restore', restore)).status, 409)
    await redis.del(unoKey)
    const restored = await api('/restore', restore)
    assert.equal(restored.status, 201)
    const loaded = await auth.load()
    assert.equal(loaded.meJid, credentials.meJid)
    assert.ok(Buffer.from(loaded.noiseKeyPair.privKey).equals(Buffer.from(credentials.noiseKeyPair.privKey)))
    assert.ok(Buffer.from((await messages.getById('fixture')).messageBytes).equals(Buffer.from([10, 2, 111, 105])))
    assert.equal(await redis.get(unoKey), 'uno-fixture')
    assert.ok(await redis.pttl(unoKey) > 0)
    const restoredConfig = JSON.parse(await redis.get(configKey))
    assert.equal(restoredConfig.autoConnect, false); assert.deepEqual(restoredConfig.webhooks, [])
    assert.equal(restoredConfig.server, 'mobile_lab'); assert.equal(restoredConfig.mobilePrimaryDraftId, undefined)
    console.log('PASS: async linked-session export/download, no overwrite, wrong password, admin removal, complete restore/crypto/messages/Uno IDs/TTL, destination offline. No WhatsApp socket opened.')
  } finally {
    if (owned) {
      const store = createZapoStore({ useRedis: true, baseStore: '/tmp', redisUrl: process.env.REDIS_URL, redisKeyPrefix: 'unoapi:zapo:' })
      try { await clearZapoSession(store.session(phone)) } finally { await store.destroy() }
      await redis.del(configKey, checkpoint, taskKey, taskKey + ':file', unoKey)
      const service = require('/app/dist/src/services/redis.js')
      await service.delConfig(phone); await service.delSessionTransientKeys(phone); await service.delSessionStatus(phone)
    }
    redis.disconnect()
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1) })
