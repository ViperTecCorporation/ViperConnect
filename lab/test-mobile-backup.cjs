// Run inside the lab web container only. Synthetic identity, no SMS/WhatsApp socket.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const Redis = require('ioredis')
const { WaAuthRedisStore } = require('@zapo-js/store-redis')
const { X25519, xeddsaSign } = require('zapo-js/crypto')
const { RegistrationVault } = require('/app/dist/src/services/mobile_primary/registration_vault.js')
const { convertWhalibmobCredentials } = require('/app/dist/src/services/mobile_primary/whalibmob_credentials.js')
const { encryptMobileBackup, decryptMobileBackup } = require('/app/dist/src/services/mobile_primary/backup_archive.js')

async function main() {
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  assert.equal(process.env.UNOAPI_MOBILE_PRIMARY_LAB, 'true')
  const redis = new Redis(process.env.REDIS_URL)
  const phone = '999' + String(Date.now()).slice(-11), password = randomBytes(24).toString('hex')
  let currentId
  const api = async (path, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:9876/manager/mobile-devices' + path, { method, headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    let result; try { result = JSON.parse(text) } catch { result = undefined }
    return { status: response.status, result }
  }
  const remove = async () => {
    if (!currentId) return
    const result = await api('/' + currentId + '/full', { phone, confirm: true, acknowledgeNewSms: true }, 'DELETE')
    assert.equal(result.status, 204, 'synthetic deletion failed; inspect test phone ' + phone)
    currentId = undefined
  }
  try {
    assert.equal(await redis.exists('unoapi-config:' + phone, 'unoapi:zapo:auth:' + phone), 0)
    const draft = await api('', { phone, name: 'Synthetic backup test', platform: 'android', accountType: 'personal', labConsent: true })
    assert.equal(draft.status, 201); currentId = draft.result.id
    const pair = async () => { const p = await X25519.generateKeyPair(); return { private: Buffer.from(p.privKey).toString('base64'), public: Buffer.concat([Buffer.from([5]), p.pubKey]).toString('base64') } }
    const identityKeyPair = await pair(), signed = await pair()
    const store = { phoneNumber: phone, registered: true, codePending: false, noiseKeyPair: await pair(), identityKeyPair, signedPreKey: { ...signed, id: 17, signature: Buffer.from(await xeddsaSign(Buffer.from(identityKeyPair.private, 'base64'), Buffer.from(signed.public, 'base64'))).toString('base64') }, registrationId: 100, name: 'Synthetic', version: '2.26.27.70', device: { os: 'android', business: false, manufacturer: 'Samsung', model: 'Galaxy', modelId: 'SM-S928B', osVersion: '14', osBuildNumber: 'UP1A' } }
    const advSecret = randomBytes(32).toString('base64')
    const state = { status: 'registered', updatedAt: Date.now(), canonicalPhone: phone, store, advSecret }
    const vault = new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY)
    await redis.set('mobile-primary:{v1}:registration:' + currentId, vault.seal(currentId, state))
    const epoch = { rawId: 123, currentKeyIndex: 2, companions: [{ deviceJid: phone + ':2@s.whatsapp.net', keyIndex: 2, companionIdentityPublicKey: randomBytes(32).toString('base64'), addedAtSeconds: 100 }] }
    const sourceEpochKey = 'mobile-primary:{v1}:companions:' + currentId
    await redis.set(sourceEpochKey, vault.seal(sourceEpochKey, epoch))
    await redis.set('unoapi-config:' + phone, JSON.stringify({ provider: 'zapo', server: 'mobile_lab', useRedis: true, useS3: true, autoConnect: false, webhooks: [], mobilePrimaryDraftId: currentId, mobilePrimaryImported: true }))
    const auth = new WaAuthRedisStore({ redis, keyPrefix: 'unoapi:zapo:', sessionId: phone })
    const credentials = await convertWhalibmobCredentials(store, { expectedCanonicalPhone: phone, advSecretKey: Buffer.from(advSecret, 'base64') })
    await auth.save(credentials)
    const signalKey = `unoapi:zapo:signal:sess:${phone}:123:s.whatsapp.net:0`
    const signalBytes = randomBytes(128)
    await redis.set(signalKey, signalBytes)
    const setKey = `unoapi:zapo:sk:grp:${phone}:123@g.us`, sortedKey = `unoapi:zapo:signal:pk:ids:${phone}`
    await redis.sadd(setKey, '123:s.whatsapp.net:0')
    await redis.zadd(sortedKey, 1, '42')
    const exported = await api('/' + currentId + '/backup', { password, confirmSuspend: true })
    assert.equal(exported.status, 200, 'export failed: ' + exported.result?.error)
    assert.ok(exported.result.archive); assert.equal(exported.result.sourceSuspended, true)
    assert.equal(JSON.parse(await redis.get('unoapi-config:' + phone)).autoConnect, false)
    const archive = exported.result.archive
    assert.equal((await api('/restore', { archive, password, confirmOriginOffline: true })).status, 409)
    assert.equal((await api('/restore', { archive, password: 'incorrect-password-test', confirmOriginOffline: true })).status, 400)
    await remove()
    const mismatch = await decryptMobileBackup(archive, password)
    assert.equal(await redis.exists(sourceEpochKey), 0)
    assert.deepEqual(mismatch.companionEpoch, epoch)
    mismatch.registration.store.noiseKeyPair = await pair()
    const wrongIdentity = await api('/restore', { archive: await encryptMobileBackup(mismatch, password), password, confirmOriginOffline: true })
    assert.equal(wrongIdentity.status, 400)
    assert.equal(await redis.exists('unoapi-config:' + phone, 'unoapi:zapo:auth:' + phone), 0)
    const restored = await api('/restore', { archive, password, confirmOriginOffline: true })
    assert.equal(restored.status, 201, 'restore failed: ' + restored.result?.error)
    currentId = restored.result.device.id
    const restoredEpochKey = 'mobile-primary:{v1}:companions:' + currentId
    assert.deepEqual(vault.open(restoredEpochKey, await redis.get(restoredEpochKey)), epoch)
    assert.equal(await redis.pttl(restoredEpochKey), -1)
    assert.equal(restored.result.status, 'disconnected')
    const config = JSON.parse(await redis.get('unoapi-config:' + phone))
    assert.equal(config.autoConnect, false); assert.deepEqual(config.webhooks, [])
    assert.deepEqual(await redis.getBuffer(signalKey), signalBytes)
    assert.equal(await redis.pttl(signalKey), -1)
    assert.deepEqual(await redis.smembers(setKey), ['123:s.whatsapp.net:0'])
    assert.deepEqual(await redis.zrange(sortedKey, 0, -1, 'WITHSCORES'), ['42', '1'])
    const loaded = await auth.load()
    assert.deepEqual(Buffer.from(loaded.noiseKeyPair.privKey), Buffer.from(credentials.noiseKeyPair.privKey))
    assert.equal(vault.open(currentId, await redis.get('mobile-primary:{v1}:registration:' + currentId)).canonicalPhone, phone)
    assert.equal(await redis.exists('unoapi-lease:zapo-session:' + phone), 0)
    await remove()
    assert.equal(await redis.exists('unoapi-config:' + phone, 'unoapi:zapo:auth:' + phone, signalKey, setKey, sortedKey), 0)
    assert.equal(await redis.exists(restoredEpochKey), 0)
    console.log('PASS: synthetic export, conflict, wrong password, delete, restore, binary state, offline state, vault rewrap and cleanup. No WhatsApp connection requested.')
  } finally {
    try { await remove() } finally { redis.disconnect() }
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1) })
