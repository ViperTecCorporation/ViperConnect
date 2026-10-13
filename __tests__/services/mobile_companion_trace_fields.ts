import { proto } from 'zapo-js'
import { companionProtoSummary, companionAttributeValues, safeCompanionPlatform } from '../../src/services/mobile_primary/companion_trace_fields'
import { companionNodeShape, companionQrShape, observeCompanionQuery } from '../../src/services/mobile_primary/companion_trace'

test('QR reveals only the known platform, not keys or reference', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  expect(companionQrShape(`SECRET,${key},${key},${key},e`)).toMatchObject({ platform: 'e' })
  expect(safeCompanionPlatform('SECRET')).toBe('redacted')
  expect(safeCompanionPlatform('')).toBeUndefined()
})
test('client pairing flags decode without subscription or unknown payloads', () => {
  const data = proto.ClientPairingProps.encode({ isChatDbLidMigrated: true, isSyncdPureLidSession: false, subscriptionSyncPayload: Buffer.from('SECRET') }).finish()
  const result = companionNodeShape({ tag: 'client-props', content: data })
  expect(result).toMatchObject({ clientPairingProps: { isChatDbLidMigrated: true, isSyncdPureLidSession: false }, subscriptionPayloadPresent: true })
  expect(JSON.stringify(result)).not.toContain('SECRET')
  expect(companionProtoSummary('device-identity', data)).toBeUndefined()
  expect(companionProtoSummary('client-props', Buffer.alloc(8193))).toBeUndefined()
  expect(companionProtoSummary('client-props', Buffer.from([255]))).toEqual({ protoDecodeFailed: true })
})
test('device properties decode only at their explicit tag with bounded fields', () => {
  const data = proto.DeviceProps.encode({ os: 'Android', platformType: proto.DeviceProps.PlatformType.ANDROID_PHONE, version: { primary: 13 }, requireFullSync: true }).finish()
  expect(companionProtoSummary('device-props', data)).toMatchObject({ deviceProps: { os: 'Android', platformType: 16, requireFullSync: true } })
  const secret = proto.DeviceProps.encode({ os: 'SECRET', platformType: 999 }).finish()
  expect(JSON.stringify(companionProtoSummary('device-props', secret))).not.toContain('SECRET')
})
test('attribute values cannot expose raw IDs or arbitrary text', () => {
  expect(companionAttributeValues({ id: 'SECRET', jid: 'SECRET', type: 'result', stage: 'companion_hello', code: '400', version: 'SECRET' })).toEqual({ type: 'result', stage: 'companion_hello', code: 400 })
})
test('primary-hello tracing preserves failure identity without copying error text', async () => {
  const error = new Error('SECRET')
  const mobile = { queryWithContext: jest.fn().mockRejectedValue(error) }
  const log = jest.fn(), stop = observeCompanionQuery(mobile, log)
  await expect(mobile.queryWithContext('companion-host.primary-hello', { tag: 'iq' })).rejects.toBe(error)
  expect(log).toHaveBeenCalledWith('MOBILE_COMPANION_PRIMARY_HELLO_QUERY_FAILED', expect.objectContaining({ diagnostic: expect.objectContaining({ reason: 'unclassified' }) }))
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET')
  expect(mobile.queryWithContext).not.toBeUndefined(); stop()
})
