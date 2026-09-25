import { MobileCompanionOperations, validateCompanionCommand, startCompanionWorker } from '../../src/services/mobile_primary/companion_operations'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'

const draft = '00000000-0000-0000-0000-000000000001'
const fence = { key: 'lease', token: 'owner' }
function fixture() {
  let raw = '', lease = 'owner'
  const redis = { get: jest.fn(async () => raw || null), eval: jest.fn(async (_: string, { keys, arguments: args }: any) => {
    if (args[0] !== raw || keys.length > 1 && args[2] !== lease) return 0
    raw = args[1]; return 1
  }) }
  const operations = new MobileCompanionOperations(redis, new RegistrationVault('ab'.repeat(32)), draft)
  const mobile = { listCompanions: jest.fn().mockResolvedValue([{ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 2, addedAtSeconds: 100, companionIdentityPublicKey: 'SECRET' }]), linkCompanion: jest.fn().mockResolvedValue({ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 2 }), linkCompanionByCode: jest.fn().mockResolvedValue({ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 2 }), revokeCompanion: jest.fn().mockResolvedValue(undefined) }
  return { operations, mobile, redis, raw: () => raw, loseLease: () => { lease = 'other' } }
}
test.each([null, {}, { action: 'logout' }, { action: 'list', extra: true }, { action: 'code', value: 'ABCD1234' }, { action: 'code', value: '123456', confirm: true }, { action: 'revoke', value: '*', confirm: true }, { action: 'qr', value: 'https://example.com', confirm: true }])('rejects invalid or unconfirmed commands %j', value => {
  expect(() => validateCompanionCommand(value)).toThrow('mobile_companion')
})
test('list is claimed once, filtered, encrypted and scoped', async () => {
  const f = fixture(), op = await f.operations.submit({ action: 'list' })
  await f.operations.tick(f.mobile, fence, () => true)
  await f.operations.tick(f.mobile, fence, () => true)
  const status = await f.operations.status(op.id)
  expect(status.state).toBe('done'); expect(f.mobile.listCompanions).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(status)).not.toContain('SECRET')
  expect(f.raw()).not.toContain('deviceJid')
  await expect(f.operations.status('another-id')).rejects.toThrow('expired')
})
test.each(['code', 'qr', 'revoke'])('executes %s only through the existing mobile coordinator', async action => {
  const f = fixture()
  const value = action === 'code' ? 'ABCD1234' : action === 'qr' ? `ref,${Array(3).fill(Buffer.alloc(32, 7).toString('base64')).join(',')},1` : '999123456789:2@s.whatsapp.net'
  const op = await f.operations.submit({ action, value, confirm: true })
  expect(JSON.stringify(await f.operations.status(op.id))).not.toContain(value)
  await f.operations.tick(f.mobile, fence, () => true)
  expect((await f.operations.status(op.id)).state).toBe('done')
  const method = action === 'code' ? f.mobile.linkCompanionByCode : action === 'qr' ? f.mobile.linkCompanion : f.mobile.revokeCompanion
  expect(method).toHaveBeenCalledWith(value)
})
test('lost ownership and inactive sockets cannot claim commands', async () => {
  const f = fixture(), op = await f.operations.submit({ action: 'list' })
  await f.operations.tick(f.mobile, fence, () => false)
  f.loseLease(); await f.operations.tick(f.mobile, fence, () => true)
  expect(f.mobile.listCompanions).not.toHaveBeenCalled()
  expect((await f.operations.status(op.id)).state).toBe('queued')
})
test('uncertain mutations are not retried and require list before another mutation', async () => {
  const f = fixture(), op = await f.operations.submit({ action: 'code', value: 'ABCD1234', confirm: true })
  f.mobile.linkCompanionByCode.mockRejectedValue(new Error('sensitive provider details'))
  await f.operations.tick(f.mobile, fence, () => true)
  await f.operations.tick(f.mobile, fence, () => true)
  expect(await f.operations.status(op.id)).toEqual({ id: op.id, state: 'unknown' })
  expect(f.mobile.linkCompanionByCode).toHaveBeenCalledTimes(1)
  await expect(f.operations.submit({ action: 'code', value: 'ABCD1234', confirm: true })).rejects.toThrow('refresh_required')
  await f.operations.submit({ action: 'list' })
})
test('busy and expired commands do not invoke the provider', async () => {
  jest.useFakeTimers()
  try {
    const f = fixture(), op = await f.operations.submit({ action: 'list' })
    await expect(f.operations.submit({ action: 'list' })).rejects.toThrow('busy')
    jest.advanceTimersByTime(61000)
    await f.operations.tick(f.mobile, fence, () => true)
    expect((await f.operations.status(op.id)).state).toBe('expired')
    expect(f.mobile.listCompanions).not.toHaveBeenCalled()
  } finally { jest.useRealTimers() }
})
test('worker lane serializes ticks and stops without touching message processing', async () => {
  jest.useFakeTimers()
  try {
    const tick = jest.fn().mockResolvedValue(undefined)
    const stop = startCompanionWorker({ tick } as any, {} as any, fence, () => true)
    await jest.advanceTimersByTimeAsync(2100)
    expect(tick).toHaveBeenCalledTimes(2)
    stop(); await jest.advanceTimersByTimeAsync(2100)
    expect(tick).toHaveBeenCalledTimes(2)
  } finally { jest.useRealTimers() }
})
