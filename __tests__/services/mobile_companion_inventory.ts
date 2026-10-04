import { companionInventory, installCompanionInventory } from '../../src/services/mobile_primary/companion_inventory'

function fixture() {
  const mobile = { reconcileCompanions: jest.fn().mockResolvedValue([]), listCompanions: jest.fn().mockResolvedValue([]) }
  const deps = { identity: jest.fn(() => ({ meJid: '123@s.whatsapp.net', meLid: '456@lid' })), invalidate: jest.fn().mockResolvedValue(1),
    sync: jest.fn().mockResolvedValue([{ jid: '123@s.whatsapp.net', deviceJids: ['123:0@s.whatsapp.net', '123:2@s.whatsapp.net'] }]), current: jest.fn(() => true) }
  let now = 100
  const original = mobile.reconcileCompanions
  const dispose = installCompanionInventory(mobile, deps, () => now)
  return { mobile, deps, original, dispose, advance: () => { now += 15000 } }
}
test('live QR companion remains visible with empty epoch; no crypto metadata fabricated', async () => {
  const f = fixture()
  expect(await companionInventory(f.mobile)!()).toEqual([{ deviceJid: '123:2@s.whatsapp.net', canRevoke: false }])
  expect(f.deps.invalidate.mock.calls).toEqual([['123@s.whatsapp.net'], ['456@lid']])
  expect(f.original).not.toHaveBeenCalled()
  f.dispose(); expect(companionInventory(f.mobile)).toBeUndefined()
})
test('deduplicates concurrent refreshes and expires short cache', async () => {
  const f = fixture(), list = companionInventory(f.mobile)!
  await Promise.all([list(), list(), list()]); expect(f.deps.sync).toHaveBeenCalledTimes(1)
  f.advance(); await list(); expect(f.deps.sync).toHaveBeenCalledTimes(2)
  f.dispose()
})
test('explicit refresh bypasses cached success after remote unlink while deduplicating in-flight requests', async () => {
  const f = fixture(), list = companionInventory(f.mobile)!
  expect(await list()).toHaveLength(1)
  f.deps.sync.mockResolvedValue([{ jid: '123@s.whatsapp.net', deviceJids: ['123:0@s.whatsapp.net'] }])
  const result = await Promise.all([list(true), list(true)])
  expect(result).toEqual([[], []])
  expect(f.deps.sync).toHaveBeenCalledTimes(2)
  expect(await list()).toEqual([])
  f.dispose()
})
test('retains epoch metadata only for server-listed devices and normalizes own LID slots', async () => {
  const f = fixture()
  f.mobile.listCompanions.mockResolvedValue([{ deviceJid: '123:2@s.whatsapp.net', keyIndex: 40, addedAtSeconds: 99 }, { deviceJid: '123:3@s.whatsapp.net', keyIndex: 39 }])
  f.deps.sync.mockResolvedValue([{ jid: '123@s.whatsapp.net', deviceJids: ['456:2@lid', '123:2@s.whatsapp.net'] }])
  expect(await companionInventory(f.mobile)!()).toEqual([{ deviceJid: '123:2@s.whatsapp.net', keyIndex: 40, addedAtSeconds: 99, canRevoke: true }])
  f.dispose()
})
test('invalidates own cache before SDK reconciliation and restores on disposal', async () => {
  const f = fixture(), original = f.original
  await f.mobile.reconcileCompanions()
  expect(f.deps.invalidate.mock.invocationCallOrder[0]).toBeLessThan(original.mock.invocationCallOrder[0])
  f.dispose(); expect(f.mobile.reconcileCompanions).toBe(original)
})
test('provider failure is explicit and a later query can retry without false empty success', async () => {
  const f = fixture(), list = companionInventory(f.mobile)!
  f.deps.sync.mockRejectedValueOnce(new Error('network'))
  await expect(list()).rejects.toThrow('network')
  expect(await list()).toHaveLength(1)
  f.dispose()
})
test('rejects cross-account device rows and lost ownership, including in-flight queries', async () => {
  const f = fixture(), list = companionInventory(f.mobile)!
  f.deps.sync.mockResolvedValueOnce([{ jid: '123@s.whatsapp.net', deviceJids: ['789:2@s.whatsapp.net'] }])
  await expect(list()).rejects.toThrow('scope_invalid')
  f.deps.sync.mockImplementationOnce(async () => { f.deps.current.mockReturnValue(false); return [] })
  await expect(list()).rejects.toThrow('not_connected')
  f.dispose()
})
test('missing identity, missing server snapshot and disposed runtimes cannot list', async () => {
  const f = fixture(), list = companionInventory(f.mobile)!
  f.deps.identity.mockReturnValueOnce({ meJid: '', meLid: '' })
  await expect(list()).rejects.toThrow('identity_missing')
  f.deps.sync.mockResolvedValueOnce([])
  await expect(list()).rejects.toThrow('unavailable')
  f.dispose(); expect(() => list()).toThrow('not_connected')
})
