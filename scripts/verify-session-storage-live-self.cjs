/* Verify the already-sent DEV self fixtures. No message POST, retry or replay. */
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')
const phone = '5566936183915'
const ids = {
  text: '93ea43b0-dbf5-11f1-9b16-a1854dd7c67a',
  reply: 'ad486050-dbf8-11f1-b333-017474b9a3f6',
  image: 'ad6231f9-b7fe-4991-84f4-3f4f366fa0e7',
  edit: 'd18b3690-dbf8-11f1-9f42-7771678e14fb',
}

async function main() {
  assert.equal(process.env.STORAGE_LIVE_SELF_VERIFY_CONFIRM, 'lab-existing-self-only')
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
  const redis = new (app('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  redis.on('error', () => {})
  let db, stage = 'preflight'
  try {
    const config = JSON.parse(await redis.get(`unoapi-config:${phone}`) || '{}')
    assert.equal(config.server, 'mobile_lab'); assert.equal(config.sessionStorage?.backend, 'sqlite')
    assert.ok(!config.sessionStorage.fixture); assert.equal(config.mobilePrimaryImported, true)
    assert.match(config.sessionStorage.storageId, /^[a-f0-9-]{36}$/)
    const { DatabaseSync } = app('node:sqlite'), { proto } = app('zapo-js')
    db = new DatabaseSync(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage', config.sessionStorage.storageId, 'session.sqlite'), { readOnly: true })
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    const value = key => {
      const row = db.prepare('SELECT value FROM uno_kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)').get(key, Date.now())
      return row && Buffer.from(row.value).toString()
    }
    const read = kind => {
      stage = kind
      const uno = ids[kind], provider = value(`unoapi-id_rev:${phone}:${uno}`)
      assert.ok(provider); assert.equal(value(`unoapi-id:${phone}:${provider}`), uno)
      const row = db.prepare('SELECT * FROM mailbox_messages WHERE session_id=? AND message_id=?').get(phone, provider)
      assert.equal(row?.from_me, 1); assert.ok(row.message_bytes)
      const projected = JSON.parse(value(`unoapi:zapo:panel:${phone}:outgoing:${uno}`) || '{}')
      assert.ok(['sent', 'delivered', 'read', 'played'].includes(projected.status))
      return { provider, row, content: proto.Message.decode(row.message_bytes) }
    }
    const text = read('text'), reply = read('reply'), image = read('image'), edit = read('edit')
    const marker = text.content.conversation || text.content.extendedTextMessage?.text
    assert.ok(marker?.startsWith('[Teste SQLite DEV] '))
    assert.equal(reply.content.extendedTextMessage?.text, marker + ' resposta')
    assert.equal(reply.content.extendedTextMessage?.contextInfo?.stanzaId, text.provider)
    assert.equal(image.content.imageMessage?.caption, marker + ' imagem')
    assert.equal(edit.content.protocolMessage?.key?.id, image.provider)
    const editedImage = edit.content.protocolMessage?.editedMessage?.imageMessage
    assert.equal(editedImage?.caption, marker + ' legenda editada')
    const originalData = { ...image.content.imageMessage }
    const editedData = { ...editedImage }
    delete originalData.caption; delete editedData.caption
    assert.deepEqual(editedData, originalData)
    const headers = { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN }
    stage = 'history_http'
    const history = await fetch(`http://web:9876/v15.0/${phone}/conversations/${encodeURIComponent(text.row.thread_jid)}/messages?limit=100`, { headers, signal: AbortSignal.timeout(15000) })
    assert.equal(history.status, 200)
    const page = await history.json()
    assert.ok(page.data.some(item => item.id === text.provider || item.reply_id === ids.text))
    assert.ok(page.data.some(item => item.id === image.provider || item.reply_id === ids.image))
    const sharp = app('sharp')
    let downloaded = 0
    for (const id of [ids.image, image.provider]) {
      stage = id === ids.image ? 'media_uno_http' : 'media_provider_http'
      const media = await fetch(`http://web:9876/v15.0/${phone}/messages/${id}/media`, { headers, signal: AbortSignal.timeout(30000) })
      if (!media.ok) {
        const error = await media.json().catch(() => ({}))
        throw Error('existing_media_' + media.status + '_' + (error.error_code || 'unknown'))
      }
      assert.match(media.headers.get('content-type') || '', /^image\/png/)
      const bytes = Buffer.from(await media.arrayBuffer()), metadata = await sharp(bytes).metadata()
      assert.equal(metadata.width, 32); assert.equal(metadata.height, 32)
      downloaded += bytes.length
    }
    stage = 'integrity'
    const { validateLiveIdMappings } = app('/app/dist/src/services/session_storage/id_validation.js')
    assert.ok(validateLiveIdMappings({ get: (sql, args) => db.prepare(sql).get(...args) }, phone))
    const pairs = Number(db.prepare('SELECT COUNT(*) n FROM uno_kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at>?)').get(`unoapi-id:${phone}:%`, Date.now()).n)
    assert.equal(await redis.get(`unoapi-status:${phone}`), 'online')
    assert.equal(await redis.exists(`unoapi-lease:zapo-session:${phone}`), 1)
    console.log(JSON.stringify({ existingSelfFixturesPassed: true, realFixtures: 4, sentProjection: true, reciprocalIds: true,
      quotedProviderId: true, captionEditPreservesAllMediaFields: true, historyHttp: true, mediaUnoAndProviderHttp: true,
      downloadedBytes: downloaded, sqliteQuickCheck: 'ok', liveIdPairs: pairs, onlineWithLease: true, newSends: 0 }))
  } catch (error) {
    console.error(JSON.stringify({ existingSelfFixturesPassed: false, stage, error: error.message }))
    process.exitCode = 1
  } finally { db?.close(); await redis.quit() }
}
main().then(() => process.exit(process.exitCode || 0)).catch(() => process.exit(1))
