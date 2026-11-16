/* Offline smoke test of the compiled runtime; no credentials, WA or external network. */
process.env.WEBHOOK_ASYNC = 'false'
process.env.WEBHOOK_CB_ENABLED = 'false'
process.env.WEBHOOK_PREFER_PN_OVER_LID = 'false'
process.env.REDIS_URL = ''
process.env.LOG_LEVEL = 'error'
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { ListenerZapo } = require(path.resolve('dist/src/services/listener_zapo'))
const { OutgoingCloudApi } = require(path.resolve('dist/src/services/outgoing_cloud_api'))
const { defaultConfig } = require(path.resolve('dist/src/services/config'))
const { zapoStoreRegistry } = require(path.resolve('dist/src/services/zapo/zapo_store_registry'))

async function main() {
  const files = new Map(), ids = new Map(), records = new Map(), deliveries = []
  const downloads = []
  let base, failure = false, receiverFailure
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        const bytes = files.get(decodeURIComponent(req.url.slice('/media/'.length)))
        assert.ok(bytes, 'media must already be stored')
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes); return
      }
      const chunks = []
      for await (const part of req) chunks.push(part)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const messages = body.entry[0].changes[0].value.messages
      assert.equal(messages.length, 1, 'one message per webhook, as consumed by current receiver')
      const message = messages[0]
      deliveries.push(message)
      if (['video', 'image'].includes(message.type)) {
        const media = message[message.type]
        assert.ok(!message.context, 'parent must not quote its reply')
        const bytes = Buffer.from(await (await fetch(media.url)).arrayBuffer())
        assert.deepEqual(bytes, files.get(media.id), 'receiver downloaded persisted bytes')
      } else if (message.context?.id?.startsWith('status-media-')) {
        assert.ok(records.has(message.context.id), 'quoted parent must be accepted before reply')
        assert.equal(message.context.message_id, message.context.id)
      }
      // Model existing receiver deduplication by source ID, including replays.
      if (!records.has(message.id)) records.set(message.id, message)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
    } catch (error) {
      receiverFailure = error
      res.writeHead(500); res.end('synthetic receiver assertion failed')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  try {
    const dataStore = new Proxy({
      loadUnoId: async id => ids.get(id), loadProviderId: async id => [...ids].find(([, uno]) => uno === id)?.[0],
      setUnoId: async (provider, uno) => { if (!ids.has(provider)) ids.set(provider, uno); return ids.get(provider) },
    }, { get: (target, key) => target[key] || (async () => undefined) })
    const mediaStore = {
      getMedia: async (_base, id) => files.has(id) ? { url: `${base}/media/${id}`, mime_type: 'video/mp4', filename: 'status.mp4' } : undefined,
      saveDownloadedMedia: async (message, bytes) => { files.set(message.key.id, Buffer.from(bytes)); return message },
    }
    const store = { dataStore, mediaStore }
    zapoStoreRegistry.get = () => ({ session: phone => {
      assert.equal(phone, '5511888888888', 'lookup must stay scoped to this session')
      return { contacts: { getByJid: async lid => lid === '94047083475061@lid' ? { phoneNumber: '5511888888888@s.whatsapp.net' } : undefined } }
    } })
    const config = { ...defaultConfig, provider: 'zapo', getStore: async () => store, shouldIgnoreJid: () => false, shouldIgnoreKey: () => false }
    const webhook = { id: 'synthetic', urlAbsolute: `${base}/webhooks/whatsapp/5511888888888`, enabled: true,
      sendIncomingMessages: true, sendOutgoingMessages: true, sendGroupMessages: true, sendUpdateMessages: true, sendNewsletterMessages: true, timeoutMs: 5000 }
    const httpDelivery = new OutgoingCloudApi(async () => config, async () => false, async () => undefined)
    const published = []
    const outgoing = { send: async (phone, payload) => { published.push(JSON.parse(JSON.stringify(payload))); await httpDelivery.sendHttp(phone, webhook, payload) } }
    const metadata = { resolve: async (_phone, message) => {
      if (!message.message.videoMessage && !message.message.imageMessage) return message
      downloads.push(message.key.id)
      if (failure) throw new Error('synthetic media unavailable')
      return { ...message, __unoapiMediaBytes: Buffer.from(`synthetic-media:${message.key.id}`) }
    } }
    const listener = () => new ListenerZapo(outgoing, { send: async () => undefined }, async () => config, metadata, 0)
    const reply = (id, status, type = 'videoMessage', participant = '5511888888888@s.whatsapp.net', contact = '5511999999999') => ({
      key: { id, remoteJid: `${contact}@s.whatsapp.net`, fromMe: false }, messageTimestamp: 1793849677,
      message: { extendedTextMessage: { text: 'synthetic status reply', contextInfo: { stanzaId: status, remoteJid: 'status@broadcast', participant,
        quotedMessage: { [type]: { mimetype: type === 'videoMessage' ? 'video/mp4' : 'image/jpeg', mediaKey: Buffer.alloc(32), directPath: '/synthetic-only' } } } } },
    })
    const send = message => listener().process('5511888888888', [message], 'notify')
    await send(reply('reply-video', 'status-video'))
    assert.deepEqual(deliveries.slice(0, 2).map(m => m.type), ['video', 'text'])
    assert.equal(deliveries[1].text.body, 'synthetic status reply')
    assert.equal(deliveries[1].context.id, deliveries[0].id)
    const firstId = deliveries[0].id
    await send(reply('reply-video-2', 'status-video'))
    assert.equal(deliveries[2].id, firstId, 'same status/chat uses same parent')
    assert.equal(downloads.filter(id => id === 'status-video').length, 1, 'stored media reused')
    const beforeReplay = records.size
    await send(reply('reply-video-2', 'status-video'))
    assert.equal(records.size, beforeReplay, 'replay creates no new bubble')
    await send(reply('reply-image', 'status-image', 'imageMessage'))
    assert.deepEqual(deliveries.slice(-2).map(m => m.type), ['image', 'text'])
    await send(reply('reply-other-chat', 'status-video', 'videoMessage', '5511888888888@s.whatsapp.net', '5511977777777'))
    assert.notEqual(deliveries.at(-2).id, firstId, 'different chat gets a separate parent')
    await send(reply('reply-own-lid', 'status-video', 'videoMessage', '94047083475061@lid'))
    assert.equal(deliveries.at(-2).id, firstId, 'own LID and PN must use the same parent')
    assert.equal(deliveries.at(-1).context.id, firstId)
    failure = true
    await send(reply('reply-unavailable', 'status-unavailable'))
    assert.equal(deliveries.at(-1).type, 'text')
    assert.equal(deliveries.at(-1).context.status.available, false)
    const beforeForeign = downloads.length
    await send(reply('reply-foreign-status', 'foreign-status', 'videoMessage', '5511666666666@s.whatsapp.net'))
    assert.equal(downloads.length, beforeForeign, 'foreign status must not be recovered')
    assert.equal(deliveries.at(-1).context.status, undefined)
    assert.equal(published[0].entry[0].changes[0].value.messages.length, 1, 'shared payload unchanged by Chatwoot adapter')
    if (receiverFailure) throw receiverFailure
    console.log(JSON.stringify({ result: 'PASS', environment: 'isolated-dev-runtime',
      scenarios: ['video', 'image', 'parent-before-reply', 'quote-reference', 'persisted-bytes-download', 'same-chat-reuse', 'replay-dedup', 'contact-isolation', 'own-lid-session-scoped', 'unavailable-media', 'foreign-status', 'payload-isolation'],
      httpRequests: deliveries.length, storedObjects: files.size, mediaDownloads: downloads.length,
      whatsappConnections: 0, whatsappMessagesSent: 0, externalNetwork: false }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
