import { historyAfterProvision } from '../../src/services/mobile_primary/companion_history_after_provision'

function setup() {
  const order: string[] = []
  const mobile = { sendHistorySyncBootstrap: jest.fn(async () => { order.push('bootstrap') }),
    shareAppStateSyncKeys: jest.fn(async () => { order.push('keys') }),
    listCompanions: jest.fn(async () => [{ deviceJid: 'target', keyIndex: 1 }]) }
  return { order, mobile }
}
test('native bootstrap and keys run before enqueue; duplicate provisioning queues only once', async () => {
  const { order, mobile } = setup(), enqueue = jest.fn(async () => { order.push('enqueue') })
  const original = mobile.sendHistorySyncBootstrap
  const dispose = historyAfterProvision(mobile, enqueue, jest.fn())
  await mobile.sendHistorySyncBootstrap(); await mobile.shareAppStateSyncKeys()
  // Above methods are typed zero-argument mocks; explicitly exercise real target below.
  expect(enqueue).not.toHaveBeenCalled()
  await (mobile.sendHistorySyncBootstrap as any)('target'); await (mobile.shareAppStateSyncKeys as any)('target')
  expect(order.slice(-3)).toEqual(['bootstrap', 'keys', 'enqueue'])
  await (mobile.shareAppStateSyncKeys as any)('target')
  expect(enqueue).toHaveBeenCalledTimes(1)
  dispose(); expect(mobile.sendHistorySyncBootstrap).toBe(original)
})
test('queue failure cannot reject provisioning or trigger a repeated enqueue', async () => {
  const { mobile } = setup(), onError = jest.fn(), enqueue = jest.fn(async () => { throw new Error('queue failed') })
  historyAfterProvision(mobile, enqueue, onError)
  await (mobile.sendHistorySyncBootstrap as any)('target')
  await expect((mobile.shareAppStateSyncKeys as any)('target')).resolves.toBeUndefined()
  await (mobile.shareAppStateSyncKeys as any)('target')
  expect(onError).toHaveBeenCalledTimes(1); expect(enqueue).toHaveBeenCalledTimes(1)
})
test('key failure and share without bootstrap do not queue history', async () => {
  const { mobile } = setup(), enqueue = jest.fn()
  mobile.shareAppStateSyncKeys.mockRejectedValueOnce(new Error('keys failed'))
  historyAfterProvision(mobile, enqueue, jest.fn())
  await (mobile.sendHistorySyncBootstrap as any)('target')
  await expect((mobile.shareAppStateSyncKeys as any)('target')).rejects.toThrow('keys failed')
  await (mobile.shareAppStateSyncKeys as any)('other')
  expect(enqueue).not.toHaveBeenCalled()
})
test('disposed socket does not enqueue after in-flight key share completes', async () => {
  const { mobile } = setup(), enqueue = jest.fn()
  let complete!: () => void
  mobile.shareAppStateSyncKeys.mockImplementation(async () => new Promise<void>(resolve => { complete = resolve }))
  const dispose = historyAfterProvision(mobile, enqueue, jest.fn())
  await (mobile.sendHistorySyncBootstrap as any)('target')
  const pending = (mobile.shareAppStateSyncKeys as any)('target')
  dispose(); complete(); await pending
  expect(enqueue).not.toHaveBeenCalled()
})
