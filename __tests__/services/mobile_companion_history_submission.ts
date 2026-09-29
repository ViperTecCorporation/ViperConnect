import { waitHistorySubmission } from '../../src/services/mobile_primary/companion_history_submission'
import { installHistoryBootstrap } from '../../src/services/mobile_primary/companion_history_bootstrap'

test('waits for queue submission, not hist_sync; preserves SDK keys-after sequence', async () => {
  const order: string[] = []
  const status = jest.fn().mockResolvedValueOnce({ state: 'running' }).mockResolvedValue({ state: 'submitted' })
  const pause = jest.fn(async () => { order.push('server-acked-pages') })
  const mobile = { sendHistorySyncBootstrap: async (_target: string) => { order.push('empty') },
    listCompanions: async () => [{ deviceJid: 'target', keyIndex: 1 }] }
  const dispose = installHistoryBootstrap(mobile, () => waitHistorySubmission(status, async () => true, pause))
  await mobile.sendHistorySyncBootstrap('target')
  order.push('sdk-key-share')
  expect(order).toEqual(['server-acked-pages', 'sdk-key-share'])
  expect(status).toHaveBeenCalledTimes(2)
  dispose()
})

test('empty archive permits native bootstrap fallback', async () => {
  await expect(waitHistorySubmission(async () => ({ state: 'empty' }), async () => true)).resolves.toBe('empty')
})

test.each(['unknown', 'failed', 'expired', 'unexpected'])('does not treat %s as successful submission', async state => {
  await expect(waitHistorySubmission(async () => ({ state }), async () => true)).rejects.toThrow('submission_uncertain')
})

test('socket change interrupts wait without reading or replaying a job', async () => {
  const status = jest.fn()
  await expect(waitHistorySubmission(status, async () => false)).rejects.toThrow('not_connected')
  expect(status).not.toHaveBeenCalled()
})

test('bounded deadline fails without retry', async () => {
  let time = 0
  const status = jest.fn(async () => ({ state: 'running' }))
  await expect(waitHistorySubmission(status, async () => true, async () => { time += 240000 }, () => time)).rejects.toThrow('submission_timeout')
  expect(status).toHaveBeenCalledTimes(1)
})
