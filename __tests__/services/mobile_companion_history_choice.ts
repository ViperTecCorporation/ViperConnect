import { captureCompanionHistoryChoice, withCompanionHistoryChoice } from '../../src/services/mobile_primary/companion_history_choice'

test('defaults to history and snapshots the opt-out before background work awaits', async () => {
  const mobile = {}
  expect(captureCompanionHistoryChoice(mobile)('device', 1)).toBe(true)
  let choose!: ReturnType<typeof captureCompanionHistoryChoice>
  expect(await withCompanionHistoryChoice(mobile, false, async () => { choose = captureCompanionHistoryChoice(mobile); return 7 })).toBe(7)
  expect(choose('device', 1)).toBe(false)
  expect(captureCompanionHistoryChoice(mobile)('device', 1)).toBe(false)
  expect(captureCompanionHistoryChoice({})('device', 1)).toBe(true)
  await withCompanionHistoryChoice(mobile, true, async () => { expect(captureCompanionHistoryChoice(mobile)('device', 2)).toBe(true) })
})
test('clears pending choice on rejection and refuses concurrent links', async () => {
  const mobile = {}
  await expect(withCompanionHistoryChoice(mobile, false, async () => {
    await expect(withCompanionHistoryChoice(mobile, true, async () => 1)).rejects.toThrow('busy')
    throw new Error('link failed')
  })).rejects.toThrow('link failed')
  expect(captureCompanionHistoryChoice(mobile)('other', 1)).toBe(true)
})
test('bounds remembered choices and allows reuse of a device slot', async () => {
  const mobile = {}
  await withCompanionHistoryChoice(mobile, false, async () => {
    const choose = captureCompanionHistoryChoice(mobile)
    for (let i = 0; i < 100; i++) expect(choose(`device${i}`, 1)).toBe(false)
    expect(choose('device0', 2)).toBe(false)
    expect(() => choose('overflow', 1)).toThrow('capacity')
  })
})
