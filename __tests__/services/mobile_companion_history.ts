import { CompanionHistory, type HistoryRuntime } from '../../src/services/mobile_primary/companion_history'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
const device = '00000000-0000-0000-0000-000000000001'
const body = { confirm: true, target: '999123456789:2@s.whatsapp.net' }
function fixture() {
  let raw = '', lease = 'owner'
  const redis = { get: jest.fn(async () => raw || null), eval: jest.fn(async (_: string, { keys, arguments: args }: any) => {
    if (args[0] !== raw || keys.length > 1 && args[2] !== lease) return 0
    raw = args[1]; return 1
  }) }
  const service = new CompanionHistory(redis, new RegistrationVault('ab'.repeat(32)), device)
  const runtime = { fence: { key: 'lease', token: 'owner' }, current: jest.fn().mockResolvedValue(true), linked: jest.fn().mockResolvedValue(true), packets: jest.fn().mockResolvedValue([{ message: { secret: 'content' }, count: 2 }]), send: jest.fn().mockResolvedValue({}) }
  return { service, runtime, publish: jest.fn().mockResolvedValue(undefined), raw: () => raw, loseLease: () => { lease = 'other' } }
}
test.each([null, {}, { ...body, confirm: false }, { ...body, target: 'someone@s.whatsapp.net' }, { ...body, all: true }])('requires explicit scoped confirmation %j', async invalid => {
  const f = fixture(); await expect(f.service.submit(invalid, f.publish)).rejects.toThrow('request_invalid'); expect(f.publish).not.toHaveBeenCalled()
})
test('publishes identifiers only; encrypted progress; duplicate delivery does not resend', async () => {
  const f = fixture(), job = await f.service.submit(body, f.publish)
  expect(f.publish).toHaveBeenCalledWith({ device, job: job.id })
  await f.service.consume(job.id, f.runtime); await f.service.consume(job.id, f.runtime)
  expect(f.runtime.send).toHaveBeenCalledTimes(1)
  expect(await f.service.status(job.id)).toEqual({ id: job.id, state: 'submitted', sent: 2, total: 2 })
  expect(f.raw()).not.toContain(body.target); expect(f.raw()).not.toContain('content')
  await expect(f.service.status('other')).rejects.toThrow('not_found')
})
test('serializes submissions per principal', async () => {
  const f = fixture(); await f.service.submit(body, f.publish)
  await expect(f.service.submit(body, f.publish)).rejects.toThrow('busy')
})
test('uncertain publication does not roll back or automatically retry', async () => {
  const f = fixture(); f.publish.mockRejectedValue(new Error('broker confirm lost'))
  await expect(f.service.submit(body, f.publish)).rejects.toThrow('publication_uncertain')
  await expect(f.service.submit(body, f.publish)).rejects.toThrow('busy')
})
test.each(['offline', 'not-linked', 'lost-lease', 'missing-runtime', 'empty'])('does not send for %s', async reason => {
  const f = fixture(), job = await f.service.submit(body, f.publish)
  if (reason === 'offline') f.runtime.current.mockResolvedValue(false)
  if (reason === 'not-linked') f.runtime.linked.mockResolvedValue(false)
  if (reason === 'lost-lease') f.loseLease()
  if (reason === 'empty') f.runtime.packets.mockResolvedValue([])
  await f.service.consume(job.id, reason === 'missing-runtime' ? undefined : f.runtime)
  expect(f.runtime.send).not.toHaveBeenCalled()
})
test('ambiguous sends remain unknown and are never redelivered', async () => {
  const f = fixture(), job = await f.service.submit(body, f.publish)
  f.runtime.send.mockRejectedValue(new Error('secret provider error'))
  await f.service.consume(job.id, f.runtime); await f.service.consume(job.id, f.runtime)
  expect((await f.service.status(job.id)).state).toBe('unknown')
  expect(f.runtime.send).toHaveBeenCalledTimes(1)
})
test('rechecks membership between batches, retaining partial count', async () => {
  const f = fixture(), job = await f.service.submit(body, f.publish)
  f.runtime.packets.mockResolvedValue([{ message: {}, count: 1 }, { message: {}, count: 1 }])
  f.runtime.linked.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  await f.service.consume(job.id, f.runtime)
  expect(f.runtime.send).toHaveBeenCalledTimes(1)
  expect(await f.service.status(job.id)).toMatchObject({ state: 'unknown', sent: 1, total: 1 })
})
test('expired jobs cannot send and orphaned running jobs surface uncertainty', async () => {
  jest.useFakeTimers()
  try {
    const f = fixture(), job = await f.service.submit(body, f.publish)
    jest.advanceTimersByTime(61000); await f.service.consume(job.id, f.runtime)
    expect((await f.service.status(job.id)).state).toBe('expired')
    expect(f.runtime.send).not.toHaveBeenCalled()
  } finally { jest.useRealTimers() }
})
