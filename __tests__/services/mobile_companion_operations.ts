import { MobileCompanionOperations, validateCompanionCommand, startCompanionWorker } from '../../src/services/mobile_primary/companion_operations'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import * as trace from '../../src/services/mobile_primary/companion_trace'
import { captureCompanionHistoryChoice } from '../../src/services/mobile_primary/companion_history_choice'
import { installCompanionInventory } from '../../src/services/mobile_primary/companion_inventory'

test.each(['qr', 'code'])('passes history opt-out through the %s linking lane', async action => {
  const f = fixture(), key = Buffer.alloc(32, 7).toString('base64')
  const method = action === 'qr' ? f.mobile.linkCompanion : f.mobile.linkCompanionByCode
  method.mockImplementation(async () => {
    expect(captureCompanionHistoryChoice(f.mobile)('target', 1)).toBe(false)
    return { deviceJid: 'target', keyIndex: 1 }
  })
  await f.operations.submit({ action, value: action === 'qr' ? `ref,${key},${key},${key},1` : 'ABCD1234', confirm: true, sendHistory: false })
  await f.operations.tick(f.mobile, fence, () => true)
  expect(method).toHaveBeenCalledTimes(1)
})
test('history option defaults to enabled and rejects invalid types or unrelated actions', () => {
  expect(validateCompanionCommand({ action: 'code', value: 'ABCD1234', confirm: true }).sendHistory).toBe(true)
  for (const body of [{ action: 'list', sendHistory: false }, { action: 'code', value: 'ABCD1234', confirm: true, sendHistory: 'false' }]) expect(() => validateCompanionCommand(body)).toThrow('command_invalid')
})

test.each([true, false])('pairing-code structure trace follows the isolated PEM experiment (lab=%s)', async lab => {
  const before = { lab: process.env.UNOAPI_MOBILE_PRIMARY_LAB, pem: process.env.UNOAPI_MOBILE_COMPANION_PEM_LAB, diagnostics: process.env.MOBILE_PRIMARY_DIAGNOSTICS }
  const spy = jest.spyOn(trace, 'observeCompanionQuery')
  try {
    process.env.UNOAPI_MOBILE_PRIMARY_LAB = String(lab)
    process.env.UNOAPI_MOBILE_COMPANION_PEM_LAB = 'true'
    process.env.MOBILE_PRIMARY_DIAGNOSTICS = 'false'
    const f = fixture()
    await f.operations.submit({ action: 'code', value: 'ABCD1234', confirm: true })
    await f.operations.tick(f.mobile, fence, () => true)
    expect(spy).toHaveBeenCalledTimes(lab ? 1 : 0)
    expect(f.mobile.linkCompanionByCode).toHaveBeenCalledWith('ABCD1234')
  } finally {
    for (const [key, value] of Object.entries({ UNOAPI_MOBILE_PRIMARY_LAB: before.lab, UNOAPI_MOBILE_COMPANION_PEM_LAB: before.pem, MOBILE_PRIMARY_DIAGNOSTICS: before.diagnostics })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    spy.mockRestore()
  }
})

const draft = '00000000-0000-0000-0000-000000000001'
test('list uses live server inventory even when epoch is empty', async () => {
  const f = fixture()
  f.mobile.listCompanions.mockResolvedValue([])
  const dispose = installCompanionInventory(f.mobile, {
    identity: () => ({ meJid: '999123456789@s.whatsapp.net' }), invalidate: jest.fn().mockResolvedValue(1),
    sync: jest.fn().mockResolvedValue([{ jid: '999123456789@s.whatsapp.net', deviceJids: ['999123456789:2@s.whatsapp.net'] }]), current: () => true,
  })
  try {
    const op = await f.operations.submit({ action: 'list' })
    await f.operations.tick(f.mobile, fence, () => true)
    expect((await f.operations.status(op.id)).result).toEqual(expect.objectContaining({ source: 'server_device_list',
      companions: [{ deviceJid: '999123456789:2@s.whatsapp.net', canRevoke: false }] }))
  } finally { dispose() }
})
const fence = { key: 'lease', token: 'owner' }
function fixture() {
  let raw = '', lease = 'owner'
  const redis = { get: jest.fn(async () => raw || null), eval: jest.fn(async (_: string, { keys, arguments: args }: any) => {
    if (args[0] !== raw || keys.length > 1 && args[2] !== lease) return 0
    raw = args[1]; return 1
  }) }
  const operations = new MobileCompanionOperations(redis, new RegistrationVault('ab'.repeat(32)), draft)
  const mobile = { listCompanions: jest.fn().mockResolvedValue([{ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 2, addedAtSeconds: 100, companionIdentityPublicKey: 'SECRET' }]), linkCompanion: jest.fn().mockResolvedValue({ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 2 }), linkCompanionByCode: jest.fn().mockResolvedValue({ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 2 }), revokeCompanion: jest.fn().mockResolvedValue(undefined) }
  return { operations, mobile: { ...mobile, reconcileCompanions: jest.fn().mockResolvedValue([]) }, redis, raw: () => raw, loseLease: () => { lease = 'other' } }
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
  expect(f.mobile.reconcileCompanions).toHaveBeenCalledTimes(1)
  expect(f.mobile.reconcileCompanions.mock.invocationCallOrder[0]).toBeLessThan(f.mobile.listCompanions.mock.invocationCallOrder[0])
  expect(JSON.stringify(status)).not.toContain('SECRET')
  expect(f.raw()).not.toContain('deviceJid')
  await expect(f.operations.status('another-id')).rejects.toThrow('expired')
})

test('refresh removes companions that reconciliation found unlinked remotely', async () => {
  const f = fixture(), op = await f.operations.submit({ action: 'list' })
  f.mobile.reconcileCompanions.mockImplementation(async () => { f.mobile.listCompanions.mockResolvedValue([]); return ['999123456789:2@s.whatsapp.net'] })
  await f.operations.tick(f.mobile, fence, () => true)
  expect(await f.operations.status(op.id)).toMatchObject({ state: 'done', result: { companions: [], source: 'epoch_after_reconciliation' } })
  expect(f.mobile.revokeCompanion).not.toHaveBeenCalled()
})

test('failed remote refresh does not return a stale list as successful', async () => {
  const f = fixture(), op = await f.operations.submit({ action: 'list' })
  f.mobile.reconcileCompanions.mockRejectedValue(new Error('remote unavailable'))
  await f.operations.tick(f.mobile, fence, () => true)
  expect(await f.operations.status(op.id)).toEqual({ id: op.id, state: 'unknown' })
  expect(f.mobile.listCompanions).not.toHaveBeenCalled()
})

test('ownership loss during reconciliation prevents reading or publishing the list', async () => {
  const f = fixture(), op = await f.operations.submit({ action: 'list' })
  let current = true
  f.mobile.reconcileCompanions.mockImplementation(async () => { current = false; return [] })
  await f.operations.tick(f.mobile, fence, () => current)
  expect(f.mobile.listCompanions).not.toHaveBeenCalled()
  expect((await f.operations.status(op.id)).state).toBe('running')
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
test('wrapped QR is normalized before SDK linking without altering keys or exposing secrets', async () => {
  const f = fixture()
  const key = Buffer.alloc(32, 7).toString('base64')
  const bare = `ref,with-comma,${key},${key},${key},1`
  const wrapped = `https://wa.me/settings/linked_devices#${bare}`
  expect(validateCompanionCommand({ action: 'qr', value: wrapped, confirm: true }).value).toBe(bare)
  const op = await f.operations.submit({ action: 'qr', value: wrapped, confirm: true })
  await f.operations.tick(f.mobile, fence, () => true)
  expect(f.mobile.linkCompanion).toHaveBeenCalledWith(bare)
  expect(JSON.stringify(await f.operations.status(op.id))).not.toContain(key)
})
test.each(['https://example.com/#', 'https://wa.me/other#', 'https://wa.me/settings/linked_devices?x#'])('rejects unrecognized URL QR envelope %s', prefix => {
  const key = Buffer.alloc(32, 7).toString('base64')
  expect(() => validateCompanionCommand({ action: 'qr', value: `${prefix}ref,${key},${key},${key},1`, confirm: true })).toThrow('mobile_companion_qr_invalid')
})
test('rejects empty reference and oversized wrapped QR', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  for (const ref of ['', 'x'.repeat(4096)]) {
    expect(() => validateCompanionCommand({ action: 'qr', value: `https://wa.me/settings/linked_devices#${ref},${key},${key},${key},1`, confirm: true })).toThrow('mobile_companion_qr_invalid')
  }
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
