// Synthetic Redis fixtures only. Never opens a WhatsApp client or sends messages.
// Run inside the lab web container: node lab/validation/session_messages.cjs
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { proto } = require('zapo-js')
const { createZapoStore } = require('../../dist/src/services/zapo/zapo_store')
const { sessionMessageIndex } = require('../../dist/src/services/messages/session_message_index')
const { SessionMessages } = require('../../dist/src/services/messages/session_messages')
const { getConfigRedis } = require('../../dist/src/services/config_redis')

async function main() {
  const prefix = `codex_messages_test:${randomUUID().replace(/-/g, '')}:`
  const store = createZapoStore({ useRedis: true, baseStore: '/tmp', redisUrl: process.env.REDIS_URL, redisKeyPrefix: prefix })
  const index = sessionMessageIndex(prefix)
  const phone = '9999999999999'; const peer = '123456789@lid'; const group = '120363000000000001@g.us'
  const session = store.session(phone); const now = Date.now()
  const service = new SessionMessages(getConfigRedis)
  service.index = async () => index
  const message = (id, jid = peer, timestamp = now) => ({ id, threadJid: jid, fromMe: false, timestampMs: timestamp, messageBytes: proto.Message.encode({ conversation: 'Synthetic validation fixture' }).finish() })
  try {
    await session.contacts.upsert({ jid: peer, lid: peer, displayName: 'Synthetic Alice', phoneNumber: '5511990000000', lastUpdatedMs: now })
    await session.messages.upsertBatch(Array.from({ length: 65 }, (_, i) => message(`M${String(i).padStart(3, '0')}`)))
    await session.messages.upsert(message('GROUP', group))
    await session.messages.upsert({ ...message('VIEWONCE', peer, now + 1), messageBytes: proto.Message.encode({ viewOnceMessageV2: { message: { imageMessage: { caption: 'Private fixture', mimetype: 'image/png', mediaKey: new Uint8Array([1, 2]) } } } }).finish() })
    await store.session('8888888888888').messages.upsert(message('OTHER_SESSION'))

    await index.ensure(phone)
    for (let i = 0; i < 100 && !await index.redis.get(index.key(phone, 'ready')); i++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(await index.redis.get(index.key(phone, 'ready')), '1')
    const ttlBefore = await index.redis.pttl(`${prefix}msg:${phone}:M001`)
    const first = await service.messages(phone, peer, { limit: 20 })
    assert.equal(first.data.length, 20); assert.equal(first.data[0].type, 'view_once'); assert.equal(first.data[0].media, undefined)
    await session.messages.upsert(message('ARRIVAL', peer, now + 2))
    let page = first; const all = [...first.data.map(item => item.id)]
    while (page.has_more) { assert.ok(page.next_cursor); page = await service.messages(phone, peer, { limit: 20, cursor: page.next_cursor }); all.push(...page.data.map(item => item.id)) }
    assert.equal(all.length, 66); assert.equal(new Set(all).size, 66); assert.ok(!all.includes('ARRIVAL'))
    assert.ok(await index.redis.pttl(`${prefix}msg:${phone}:M001`) <= ttlBefore)
    const conversations = await service.conversations(phone, { search: 'alice' })
    assert.equal(conversations.data.length, 1); assert.equal(conversations.data[0].name, 'Synthetic Alice')
    assert.equal((await service.conversations(phone, { kind: 'group' })).data[0].id, group)
    assert.equal((await service.messages(phone, peer, { ids: ['GROUP', 'OTHER_SESSION'] })).data.length, 0)
    await index.state(phone, ['M001'], { edited: true, text: 'Edited fixture' })
    assert.equal((await service.messages(phone, peer, { ids: ['M001'] })).data[0].edited, true)
    await index.state(phone, ['M001'], { status: 'read' })
    await index.state(phone, ['M001'], { status: 'delivered' })
    assert.equal((await service.messages(phone, peer, { ids: ['M001'] })).data[0].status, 'read')
    await index.state(phone, ['M001'], { type: 'revoked', text: 'Mensagem removida', media: null })
    assert.equal((await service.messages(phone, peer, { ids: ['M001'] })).data[0].type, 'revoked')
    await index.redis.del(`${prefix}msg:${phone}:M064`, `${prefix}msg:${phone}:M064:message_bytes`)
    const expired = await service.messages(phone, peer, { ids: ['M064'] }); assert.equal(expired.data.length, 0)
    await index.clear(phone)
    assert.equal(await index.redis.exists(index.key(phone, 'conversations')), 0)
    console.log(JSON.stringify({ fixture_validation: 'passed', timestamp_ties: 65, pages: 4, cross_session: 'isolated', ttl: 'not_refreshed', view_once: 'blocked', edit_revoke: 'passed' }))

    // Read-only HTTP validation against actual lab sessions. Print counts only.
    const token = process.env.UNOAPI_AUTH_TOKEN
    if (token) {
      const sessions = await fetch('http://127.0.0.1:9876/sessions', { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json())
      const phone = (sessions.data || []).find(item => item.provider === 'zapo')?.phone
      if (phone) {
        const response = await fetch(`http://127.0.0.1:9876/v15.0/${phone}/conversations`, { headers: { Authorization: `Bearer ${token}` } })
        assert.equal(response.status, 200)
        const page = await response.json()
        const denied = await fetch(`http://127.0.0.1:9876/v15.0/${phone}/conversations`)
        assert.ok([401, 403].includes(denied.status))
        console.log(JSON.stringify({ live_http: 'passed', conversation_count: page.data.length, unauthenticated_status: denied.status }))
      }
    }
  } finally {
    // Delete only this uniquely named synthetic prefix; never session/user data.
    assert.match(prefix, /^codex_messages_test:[a-f0-9]{32}:$/)
    let cursor = '0'; let removed = 0
    do {
      const [next, keys] = await index.redis.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 200)
      cursor = next
      if (keys.length) { assert.ok(keys.every(key => key.startsWith(prefix))); removed += await index.redis.unlink(...keys) }
    } while (cursor !== '0')
    await store.destroy()
    console.log(JSON.stringify({ synthetic_keys_removed: removed }))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
