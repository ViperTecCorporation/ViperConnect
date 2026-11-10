import { proto, type WaStoredMessageRecord } from 'zapo-js'
import { randomBytes } from 'node:crypto'
import { proposeMessageCopy, readMessageCopy } from '../../src/services/messages/message_copy_prototype'
import { ZapoMessageEdit, buildZapoEditContent } from '../../src/services/zapo/zapo_message_edit'

describe('DEV message-copy differential experiment', () => {
  const stamp = 1794000000000
  const scope = { phone: '5511888888888', thread: '123@lid', providerId: 'provider', now: stamp + 1000, legacyTtlMs: 30 * 86400000, nativeTtlMs: 7 * 86400000 }
  const fixture = (message: proto.IMessage = { conversation: 'test '.repeat(2000) }, fromMe = true) => {
    const envelope: proto.IWebMessageInfo = { key: { id: 'uno-public', remoteJid: scope.thread, fromMe, participant: '456@lid' },
      messageTimestamp: Math.floor(stamp / 1000), pushName: 'Synthetic sender', message, status: proto.WebMessageInfo.Status.DELIVERY_ACK }
    const stored = Buffer.from(proto.WebMessageInfo.encode(envelope).finish()).toString('base64')
    const native: WaStoredMessageRecord = { id: scope.providerId, threadJid: scope.thread, fromMe, timestampMs: stamp, messageBytes: proto.Message.encode(message).finish() }
    return { stored, native }
  }
  const bytes = (message: proto.IWebMessageInfo) => Buffer.from(proto.WebMessageInfo.encode(message).finish())
  test.each([true, false])('preserves every envelope byte and both IDs (fromMe=%s)', fromMe => {
    const { stored, native } = fixture(undefined, fromMe)
    const result = proposeMessageCopy(stored, native, scope)
    expect(result.compacted).toBe(true)
    expect(result.candidateBytes).toBeLessThan(result.legacyBytes)
    const restored = readMessageCopy(result.stored, native, scope)!
    expect(restored.source).toBe('native')
    expect(bytes(restored.message)).toEqual(Buffer.from(stored, 'base64'))
    expect(restored.message.key.id).toBe('uno-public')
    expect(native.id).toBe('provider')
  })
  test.each(['absent', 'changed', 'corrupt', 'wrong_author', 'wrong_thread'])('retains original content when native is %s', kind => {
    const { stored, native } = fixture()
    const packed = proposeMessageCopy(stored, native, scope)
    const changed = kind === 'absent' ? null : { ...native,
      ...(kind === 'changed' ? { messageBytes: proto.Message.encode({ conversation: 'edited later' }).finish() } : {}),
      ...(kind === 'corrupt' ? { messageBytes: Buffer.from([255, 255]) } : {}),
      ...(kind === 'wrong_author' ? { fromMe: false } : {}),
      ...(kind === 'wrong_thread' ? { threadJid: 'another@lid' } : {}) }
    const result = readMessageCopy(packed.stored, changed, scope)!
    expect(result.source).toBe('compressed_fallback')
    expect(bytes(result.message)).toEqual(Buffer.from(stored, 'base64'))
  })
  test('fallback survives native expiration without extending original retention', () => {
    const { stored, native } = fixture()
    const packed = proposeMessageCopy(stored, native, scope)
    expect(readMessageCopy(packed.stored, null, { ...scope, now: stamp + 8 * 86400000 })?.source).toBe('compressed_fallback')
    expect(readMessageCopy(packed.stored, null, { ...scope, now: stamp + scope.legacyTtlMs })).toBeUndefined()
  })
  test('does not extend an already shorter Redis expiration', () => {
    const { stored, native } = fixture()
    const packed = proposeMessageCopy(stored, native, { ...scope, legacyExpiresAt: scope.now + 5000 })
    expect(readMessageCopy(packed.stored, null, { ...scope, now: scope.now + 5000 })).toBeUndefined()
  })
  test.each(['phone', 'thread'])('does not cross %s boundaries', field => {
    const { stored, native } = fixture()
    const packed = proposeMessageCopy(stored, native, scope)
    expect(readMessageCopy(packed.stored, native, { ...scope, [field]: 'different' })).toBeUndefined()
  })
  test.each(['native_missing', 'identity_mismatch', 'author_mismatch', 'content_mismatch', 'expired', 'timestamp_mismatch'])('keeps full copy for %s', reason => {
    const { stored, native } = fixture()
    const changed = reason === 'native_missing' ? null : { ...native,
      ...(reason === 'identity_mismatch' ? { id: 'wrong-id' } : {}),
      ...(reason === 'author_mismatch' ? { fromMe: false } : {}),
      ...(reason === 'content_mismatch' ? { messageBytes: proto.Message.encode({ conversation: 'other' }).finish() } : {}),
      ...(reason === 'timestamp_mismatch' ? { timestampMs: stamp + 2000 } : {}) }
    const result = proposeMessageCopy(stored, changed, reason === 'expired' ? { ...scope, now: stamp + scope.legacyTtlMs } : scope)
    expect(result).toMatchObject({ compacted: false, stored, reason })
  })
  test('preserves legacy JSON untouched and rejects a corrupt fallback', () => {
    const storedJson = JSON.stringify({ key: { id: 'legacy' }, message: { conversation: 'text' } })
    expect(proposeMessageCopy(storedJson, null, scope).stored).toBe(storedJson)
    expect(readMessageCopy(storedJson, null, scope)?.message).toEqual(JSON.parse(storedJson))
    expect(readMessageCopy('[{"legacy":true}]', null, scope)?.message).toEqual([{ legacy: true }])
    const { stored, native } = fixture()
    const packed = JSON.parse(proposeMessageCopy(stored, native, scope).stored)
    packed.fallback = 'corrupt'
    expect(readMessageCopy(JSON.stringify(packed), null, scope)).toBeUndefined()
  })
  test.each(['imageMessage', 'videoMessage', 'documentMessage'] as const)('preserves %s descriptors for the actual caption-edit consumer', async field => {
    const message = { [field]: { caption: 'caption '.repeat(1000), mediaKey: Buffer.alloc(32, 1), fileSha256: Buffer.alloc(32, 2),
      fileEncSha256: Buffer.alloc(32, 3), directPath: '/synthetic', mimetype: 'application/octet-stream', fileName: 'file.bin' } }
    const { stored, native } = fixture(message)
    const packed = proposeMessageCopy(stored, native, scope)
    expect(packed.compacted).toBe(true)
    const original = readMessageCopy(packed.stored, null, scope)!.message
    const cache: any = { loadMessageExact: async () => original }
    const consumer = new ZapoMessageEdit(cache)
    const result = await consumer.original({ id: 'uno-public', remoteJid: scope.thread, fromMe: true })
    expect(Buffer.from(proto.Message.encode(result).finish())).toEqual(Buffer.from(native.messageBytes!))
    expect(buildZapoEditContent(result, 'new caption')).toMatchObject({ [field]: { caption: 'new caption', directPath: '/synthetic' } })
  })
  test.each(['group', 'quote', 'reaction', 'view_once', 'edit', 'revoked', 'secret'])('preserves %s protocol data without reinterpreting it', kind => {
    const base: proto.IMessage = { extendedTextMessage: { text: 'payload '.repeat(1200), contextInfo: { stanzaId: 'original-provider', participant: '456@lid',
      quotedMessage: { conversation: 'quoted' }, isForwarded: true } } }
    if (kind === 'reaction') base.reactionMessage = { key: { id: 'target-provider', remoteJid: scope.thread }, text: '👍' }
    if (kind === 'secret') base.messageContextInfo = { messageSecret: Buffer.alloc(32, 4) }
    if (kind === 'view_once') base.viewOnceMessage = { message: { imageMessage: { viewOnce: true, mediaKey: Buffer.alloc(32) } } }
    if (kind === 'edit' || kind === 'revoked') base.protocolMessage = { key: { id: 'target-provider' }, type: kind === 'edit' ? 14 : 0 }
    let { stored, native } = fixture(base)
    const testScope = kind === 'group' ? { ...scope, thread: '120363000000000@g.us' } : scope
    if (kind === 'group') {
      const group = proto.WebMessageInfo.decode(Buffer.from(stored, 'base64'))
      group.key.remoteJid = testScope.thread
      stored = Buffer.from(proto.WebMessageInfo.encode(group).finish()).toString('base64')
      native = { ...native, threadJid: testScope.thread }
    }
    const packed = proposeMessageCopy(stored, native, testScope)
    expect(packed.compacted).toBe(true)
    for (const record of [native, null]) expect(bytes(readMessageCopy(packed.stored, record, testScope)!.message)).toEqual(Buffer.from(stored, 'base64'))
  })
  test('does not force compaction when incompressible data would cost more', () => {
    const { stored, native } = fixture({ imageMessage: { jpegThumbnail: randomBytes(10000) } })
    expect(proposeMessageCopy(stored, native, scope)).toMatchObject({ stored, compacted: false, reason: 'not_smaller' })
  })
})
