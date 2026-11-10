/* Explicit DEV opt-in. Real WhatsApp messages only to the lab account itself. */
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')
const phone = process.env.STORAGE_LIVE_SELF_PHONE || '5566936183915'

async function main() {
  assert.ok(['5566936183915', '5566996269251'].includes(phone), 'lab_account_only')
  if (process.env.STORAGE_LIVE_SELF_CONFIRM !== 'lab-self-only' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.REDIS_URL !== 'redis://redis:6379' || process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY === 'true') throw Error('lab_self_opt_in_required')
  const redis = new (app('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  redis.on('error', () => {})
  let database, stage = 'preflight'
  const accepted = []
  try {
    const config = JSON.parse(await redis.get(`unoapi-config:${phone}`) || '{}')
    assert.equal(config.provider, 'zapo'); assert.equal(config.server, 'mobile_lab')
    assert.equal(config.sessionStorage?.backend, 'sqlite'); assert.equal(config.sessionStorage?.fixture, undefined)
    assert.equal(config.autoConnect, true); assert.equal(await redis.get(`unoapi-status:${phone}`), 'online')
    if (phone === '5566936183915') assert.ok(config.mobilePrimaryImported && config.mobilePrimaryDraftId)
    else assert.ok(!config.mobilePrimaryDraftId)
    for (const hook of config.webhooks || []) {
      if (hook.enabled === false || hook.disabled === true || !(hook.urlAbsolute || hook.url)) continue
      assert.equal(new URL(hook.urlAbsolute || hook.url).hostname, 'viperchatdev.vipertec.net', 'non_lab_webhook')
    }
    assert.ok(!config.sessionWebhook && !config.rejectCallsWebhook)
    assert.match(config.sessionStorage.storageId, /^[a-f0-9-]{36}$/)
    const { DatabaseSync } = app('node:sqlite'), { proto } = app('zapo-js')
    database = new DatabaseSync(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage', config.sessionStorage.storageId, 'session.sqlite'), { readOnly: true })
    const value = key => { const row = database.prepare('SELECT value FROM uno_kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)').get(key, Date.now()); return row && Buffer.from(row.value).toString() }
    const reuse = process.env.STORAGE_LIVE_SELF_REUSE_ID
    let marker = '[Teste SQLite DEV] ' + randomUUID()
    if (reuse) {
      assert.match(reuse, /^[a-f0-9-]{36}$/)
      const provider = value(`unoapi-id_rev:${phone}:${reuse}`)
      const old = provider && database.prepare('SELECT * FROM mailbox_messages WHERE session_id=? AND message_id=?').get(phone, provider)
      assert.ok(old?.from_me === 1 && old.message_bytes && old.timestamp_ms > Date.now() - 3600000)
      const content = proto.Message.decode(old.message_bytes)
      marker = content.conversation || content.extendedTextMessage?.text
      assert.ok(typeof marker === 'string' && marker.startsWith('[Teste SQLite DEV] '))
      assert.ok(value(`unoapi-key:${phone}:${reuse}`))
      const selected = await app('/app/dist/src/services/config_redis.js').getConfigRedis(phone)
      assert.equal(selected.outgoingIdempotency, true)
    }
    const headers = { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, 'Content-Type': 'application/json' }
    const send = async (kind, payload, existingId) => {
      stage = kind
      // Never retry a real send after an ambiguous HTTP response.
      let id = existingId
      if (existingId) {
        const { amqpPublish } = app('/app/dist/src/amqp.js'), d = app('/app/dist/src/defaults.js')
        const { providerQueueName } = app('/app/dist/src/services/providers/provider_queue.js')
        await amqpPublish(d.UNOAPI_EXCHANGE_BRIDGE_NAME, providerQueueName(d.UNOAPI_QUEUE_INCOMING, 'mobile_lab', 'zapo'), phone,
          { id, payload: { messaging_product: 'whatsapp', ...payload, to: phone }, options: { endpoint: 'messages' } }, { type: 'direct', maxRetries: 0 })
      } else {
        const response = await fetch(`http://web:9876/v15.0/${phone}/messages`, { method: 'POST', headers,
          body: JSON.stringify({ messaging_product: 'whatsapp', ...payload, to: phone }), signal: AbortSignal.timeout(30000) })
        assert.ok(response.ok, 'live_self_request_failed')
        id = (await response.json()).messages?.[0]?.id
      }
      assert.equal(typeof id, 'string'); accepted.push({ kind, id })
      console.log(JSON.stringify({ liveSelfAccepted: kind, id }))
      for (let attempt = 0; attempt < 120; attempt++) {
        const projected = value(`unoapi:zapo:panel:${phone}:outgoing:${id}`)
        const status = projected ? JSON.parse(projected).status : value(`unoapi-message-status:${phone}:${id}`)
        if (status === 'failed') throw Error('live_self_provider_failed')
        const provider = value(`unoapi-id_rev:${phone}:${id}`)
        const record = provider && database.prepare('SELECT * FROM mailbox_messages WHERE session_id=? AND message_id=?').get(phone, provider)
        if (['sent', 'delivered', 'read', 'played'].includes(status) && record?.message_bytes) {
          assert.equal(value(`unoapi-id:${phone}:${provider}`), id)
          console.log(JSON.stringify({ liveSelfConfirmed: kind, id, provider, status, sqliteNative: true, reciprocalIds: true }))
          return { id, provider, record, content: proto.Message.decode(record.message_bytes) }
        }
        await new Promise(done => setTimeout(done, 500))
      }
      throw Error('live_self_ack_or_sqlite_timeout')
    }
    const text = await send(reuse ? 'text_idempotent_recovery' : 'text', { type: 'text', text: { body: marker } }, reuse)
    assert.equal(text.content.conversation || text.content.extendedTextMessage?.text, marker)
    if (process.env.STORAGE_LIVE_SELF_TEXT_ONLY === 'true') {
      console.log(JSON.stringify({ liveSelfTextPassed: true, selfOnly: true, id: text.id, provider: text.provider,
        providerAckAndSqlite: true, reciprocalIds: true, newSends: reuse ? 0 : 1 }))
      return
    }
    const reuseReply = process.env.STORAGE_LIVE_SELF_REUSE_REPLY_ID
    if (reuseReply) {
      assert.match(reuseReply, /^[a-f0-9-]{36}$/)
      assert.ok(value(`unoapi-key:${phone}:${reuseReply}`))
      const provider = value(`unoapi-id_rev:${phone}:${reuseReply}`)
      const record = database.prepare('SELECT message_bytes,from_me FROM mailbox_messages WHERE session_id=? AND message_id=?').get(phone, provider)
      const content = record?.message_bytes && proto.Message.decode(record.message_bytes)
      assert.equal(record?.from_me, 1); assert.equal(content?.extendedTextMessage?.text, marker + ' resposta')
      assert.equal(content?.extendedTextMessage?.contextInfo?.stanzaId, text.provider)
    }
    const reply = await send(reuseReply ? 'reply_idempotent_recovery' : 'reply', { type: 'text', text: { body: marker + ' resposta' }, context: { message_id: text.id } }, reuseReply)
    assert.equal(reply.content.extendedTextMessage?.contextInfo?.stanzaId, text.provider)
    const png = await app('sharp')({ create: { width: 32, height: 32, channels: 3, background: '#1565c0' } }).png().toBuffer()
    const image = await send('image', { type: 'image', image: { base64: png.toString('base64'), mime_type: 'image/png', caption: marker + ' imagem' } })
    assert.equal(image.content.imageMessage?.caption, marker + ' imagem')
    const edited = await send('image_edit', { type: 'message_edit', context: { message_id: image.id }, text: { body: marker + ' legenda editada' } })
    const protocol = edited.content.protocolMessage
    assert.equal(protocol?.key?.id, image.provider)
    assert.equal(protocol?.editedMessage?.imageMessage?.caption, marker + ' legenda editada')
    stage = 'history_http'
    const history = await fetch(`http://web:9876/v15.0/${phone}/conversations/${encodeURIComponent(text.record.thread_jid)}/messages?limit=100`, { headers, signal: AbortSignal.timeout(15000) })
    assert.ok(history.ok)
    const page = await history.json()
    assert.ok(page.data.some(item => item.id === text.provider || item.reply_id === text.id))
    assert.ok(page.data.some(item => item.id === image.provider || item.reply_id === image.id))
    stage = 'media_http'
    const media = await fetch(`http://web:9876/v15.0/${phone}/messages/${image.id}/media`, { headers, signal: AbortSignal.timeout(30000) })
    assert.ok(media.ok, 'live_self_media_http_failed')
    const mediaBytes = Buffer.from(await media.arrayBuffer())
    assert.ok(mediaBytes.length > 0)
    const { validateLiveIdMappings } = app('/app/dist/src/services/session_storage/id_validation.js')
    assert.ok(validateLiveIdMappings({ get: (sql, args) => database.prepare(sql).get(...args) }, phone))
    console.log(JSON.stringify({ liveSelfPassed: true, realMessagesAndEdits: accepted.length - (reuse ? 1 : 0) - (reuseReply ? 1 : 0), idempotentRecovery: !!reuse, selfOnly: true,
      text: true, quoteProviderId: true, image: true, editPreservesImage: true, historyHttp: true, mediaHttp: true, idsConsistent: true }))
  } catch (error) {
    console.error(JSON.stringify({ liveSelfFailed: true, stage, error: error.code || error.name, accepted }))
    throw error
  } finally { database?.close(); await redis.quit() }
}
main().then(() => process.exit(0)).catch(() => process.exit(1))
