// Run inside the lab web container only. Synthetic identity, no SMS/WhatsApp socket.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const Redis = require('ioredis')
const { WaAuthRedisStore, WaMessageRedisStore, WaContactRedisStore, WaThreadRedisStore } = require('@zapo-js/store-redis')
const { proto } = require('zapo-js')
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
  const createdBackupTaskKeys = []
  const fixtureKeys = [`unoapi-id:${phone}:fixture`, `unoapi-id_rev:${phone}:uno-fixture`, `unoapi-message-status:${phone}:uno-fixture`, `unoapi-message:${phone}:123@lid:fixture`]
  let fixtureKeysOwned = false
  const api = async (path, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:9876/manager/mobile-devices' + path, { method, headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    let result; try { result = JSON.parse(text) } catch { result = undefined }
    return { status: response.status, result }
  }
  const remove = async (transferred = false) => {
    if (!currentId) return
    const result = transferred
      ? await api('/' + currentId + '/transfer-removal', { phone, confirm: true, backupValidated: true, password: process.env.UNOAPI_AUTH_TOKEN }, 'DELETE')
      : await api('/' + currentId + '/full', { phone, confirm: true, acknowledgeNewSms: true }, 'DELETE')
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
    assert.equal((await api('/' + currentId + '/transfer-removal', undefined, 'GET')).result.eligible, false)
    assert.equal((await api('/' + currentId + '/transfer-removal', { phone, confirm: true, backupValidated: true, password: process.env.UNOAPI_AUTH_TOKEN }, 'DELETE')).status, 409)
    const signalKey = `unoapi:zapo:signal:sess:${phone}:123:s.whatsapp.net:0`
    const signalBytes = randomBytes(128)
    await redis.set(signalKey, signalBytes)
    const setKey = `unoapi:zapo:sk:grp:${phone}:123@g.us`, sortedKey = `unoapi:zapo:signal:pk:ids:${phone}`
    await redis.sadd(setKey, '123:s.whatsapp.net:0')
    await redis.zadd(sortedKey, 1, '42')
    const options = { redis, keyPrefix: 'unoapi:zapo:', sessionId: phone }
    const messages = new WaMessageRedisStore(options), contacts = new WaContactRedisStore(options), threads = new WaThreadRedisStore(options)
    const content = proto.Message.encode({ imageMessage: { caption: 'synthetic image metadata', mediaKey: new Uint8Array(32) } }).finish()
    await messages.upsert({ id: 'fixture', threadJid: '123@lid', fromMe: true, timestampMs: 1790000000000, messageBytes: content })
    await contacts.upsert({ jid: '123@lid', phoneNumber: '999123456789', displayName: 'Synthetic contact', lastUpdatedMs: Date.now() })
    await threads.upsert({ jid: '123@lid', name: 'Synthetic thread' })
    assert.equal(await redis.exists(...fixtureKeys), 0)
    fixtureKeysOwned = true
    await redis.set(fixtureKeys[0], 'uno-fixture')
    await redis.set(fixtureKeys[1], 'fixture')
    await redis.set(fixtureKeys[2], 'delivered', 'PX', 120000)
    await redis.set(fixtureKeys[3], Buffer.from([0, 255, 42]))
    const minimal = await api('/' + currentId + '/backup', { password, confirmSuspend: true, mode: 'credentials' })
    assert.equal(minimal.status, 200)
    const minimalManifest = await decryptMobileBackup(minimal.result.archive, password)
    assert.equal(minimalManifest.mode, 'credentials')
    assert.ok(minimalManifest.records.every(r => !r.namespace && !r.key.startsWith('msg:') && !r.key.startsWith('contact:')))
    const accepted = await api('/' + currentId + '/backup-tasks', { password, confirmSuspend: true, mode: 'complete' })
    assert.equal(accepted.status, 202, 'background backup not accepted')
    createdBackupTaskKeys.push('mobile-primary:{v1}:backup-task:' + currentId, 'mobile-primary:{v1}:backup-task:' + currentId + ':file')
    const taskId = accepted.result.id
    let completed
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = await api('/backups', undefined, 'GET')
      completed = listed.result.tasks.find(task => task.id === taskId)
      if (completed && completed.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.equal(completed?.status, 'ready', 'background export failed: ' + completed?.error)
    assert.equal(JSON.stringify(completed).includes(password), false)
    assert.equal(JSON.stringify(completed).includes('archive'), false)
    const exported = await api('/' + currentId + '/backup-tasks/' + taskId + '/download', undefined, 'GET')
    assert.equal(exported.status, 200, 'export failed: ' + exported.result?.error)
    assert.ok(exported.result.archive)
    assert.equal((await api('/' + currentId + '/transfer-removal', undefined, 'GET')).result.eligible, true)
    assert.equal((await api('/' + currentId + '/transfer-removal', { phone, confirm: true, backupValidated: true, password: 'wrong-admin-password' }, 'DELETE')).status, 401)
    assert.equal((await api('/' + currentId + '/transfer-removal', { phone, confirm: true, backupValidated: false, password: process.env.UNOAPI_AUTH_TOKEN }, 'DELETE')).status, 400)
    assert.equal(JSON.parse(await redis.get('unoapi-config:' + phone)).autoConnect, false)
    const archive = exported.result.archive
    const fullManifest = await decryptMobileBackup(archive, password)
    assert.equal(fullManifest.version, 2); assert.equal(fullManifest.mode, 'complete')
    assert.ok(fullManifest.records.some(r => r.key === `msg:${phone}:fixture:message_bytes`))
    assert.ok(fullManifest.records.some(r => r.namespace === 'uno' && r.key === `message-status:${phone}:uno-fixture` && r.expiresAt > Date.now()))
    assert.equal((await api('/restore', { archive, password, confirmOriginOffline: true })).status, 409)
    assert.equal((await api('/restore', { archive, password: 'incorrect-password-test', confirmOriginOffline: true })).status, 400)
    await remove(true)
    assert.equal(await redis.exists(`mobile-primary:{v1}:backup-completed:${phone}`), 0)
    // Only exact, randomly scoped fixture keys created above; never a real session.
    await redis.del(...fixtureKeys)
    await redis.set(fixtureKeys[0], 'existing-destination')
    assert.equal((await api('/restore', { archive, password, confirmOriginOffline: true })).status, 409)
    assert.equal(await redis.get(fixtureKeys[0]), 'existing-destination')
    await redis.del(fixtureKeys[0])
    const mismatch = await decryptMobileBackup(archive, password)
    assert.equal(await redis.exists(sourceEpochKey), 0)
    assert.deepEqual(mismatch.companionEpoch, epoch)
    mismatch.registration.store.noiseKeyPair = await pair()
    const wrongIdentity = await api('/restore', { archive: await encryptMobileBackup(mismatch, password), password, confirmOriginOffline: true })
    assert.equal(wrongIdentity.status, 400)
    assert.equal(await redis.exists('unoapi-config:' + phone, 'unoapi:zapo:auth:' + phone), 0)
    // Old credential-only archives remain restorable by the new implementation.
    const legacy = { ...minimalManifest, version: 1 }
    delete legacy.mode
    legacy.records = legacy.records.map(({ expiresAt, ...record }) => record)
    const legacyResult = await api('/restore', { archive: await encryptMobileBackup(legacy, password), password, confirmOriginOffline: true })
    assert.equal(legacyResult.status, 201)
    currentId = legacyResult.result.device.id
    assert.equal(await messages.getById('fixture'), null)
    await remove()
    // Expired records must not be resurrected by restoration.
    const expiredKey = `unoapi-id:${phone}:expired-fixture`
    assert.equal(await redis.exists(expiredKey), 0)
    fullManifest.records.push({ namespace: 'uno', key: `id:${phone}:expired-fixture`, dump: fullManifest.records.find(r => r.namespace === 'uno' && r.key === `id:${phone}:fixture`).dump, expiresAt: Date.now() - 1000 })
    const restored = await api('/restore', { archive: await encryptMobileBackup(fullManifest, password), password, confirmOriginOffline: true })
    assert.equal(restored.status, 201, 'restore failed: ' + restored.result?.error)
    currentId = restored.result.device.id
    assert.equal(await redis.exists(expiredKey), 0)
    const restoredEpochKey = 'mobile-primary:{v1}:companions:' + currentId
    assert.deepEqual(vault.open(restoredEpochKey, await redis.get(restoredEpochKey)), epoch)
    assert.equal(await redis.pttl(restoredEpochKey), -1)
    assert.equal(restored.result.status, 'disconnected')
    const config = JSON.parse(await redis.get('unoapi-config:' + phone))
    assert.equal(config.autoConnect, false); assert.deepEqual(config.webhooks, [])
    assert.deepEqual(Buffer.from((await messages.getById('fixture')).messageBytes), Buffer.from(content))
    assert.equal((await messages.listByThread('123@lid', 10)).length, 1)
    assert.equal((await contacts.getByJid('123@lid')).displayName, 'Synthetic contact')
    assert.equal((await threads.getByJid('123@lid')).name, 'Synthetic thread')
    assert.equal(await redis.get(fixtureKeys[0]), 'uno-fixture')
    assert.equal(await redis.get(fixtureKeys[1]), 'fixture')
    assert.equal(await redis.get(fixtureKeys[2]), 'delivered')
    const restoredTtl = await redis.pttl(fixtureKeys[2])
    assert.ok(restoredTtl > 0 && restoredTtl <= 120000)
    assert.deepEqual(await redis.getBuffer(fixtureKeys[3]), Buffer.from([0, 255, 42]))
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
    console.log('PASS: credentials/full export, legacy v1 restore, conflicts, wrong password, identity mismatch, messages/indexes/contacts, Uno IDs/status, TTL/expired records, crypto/companion state, offline restore and cleanup. No WhatsApp connection requested.')
  } finally {
    try { await remove() } finally {
      if (fixtureKeysOwned) await redis.del(...fixtureKeys)
      // Exact metadata/file keys belonging only to this randomly generated fixture.
      if (createdBackupTaskKeys.length) await redis.del(...createdBackupTaskKeys)
      redis.disconnect()
    }
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1) })
