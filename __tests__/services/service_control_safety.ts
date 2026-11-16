import { storageRestartSafety, voipRestartSafety, restartSafety } from '../../src/services/service_control/safety'
import { createClient } from '@redis/client'
import { RabbitManagement } from '../../src/services/rabbitmq_management'
import { VoipService } from '../../src/services/voip_service'

jest.mock('@redis/client', () => ({ createClient: jest.fn() }))
jest.mock('../../src/services/rabbitmq_management', () => ({ RabbitManagement: jest.fn() }))
jest.mock('../../src/services/voip_service', () => ({ VoipService: jest.fn() }))

test('runtime preflight checks native restore and Rabbit work and closes its independent Redis client', async () => {
  const redis = { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn().mockResolvedValue(undefined), isOpen: true, exists: jest.fn().mockResolvedValue(0), scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [] }) }
  const rabbit = jest.fn().mockResolvedValue({ overview: { queue_totals: { messages_unacknowledged: 0 } } })
  const voip = { available: () => true, request: jest.fn(async path => path.endsWith('/calls') ? { calls: [] } : path.endsWith('/capability') ? { restoring: false } : { router: { locks: [] }, registrations: { webrtc: [], sipRtp: [] } }) }
  ;(createClient as jest.Mock).mockReturnValue(redis)
  ;(RabbitManagement as jest.Mock).mockImplementation(() => ({ resourceSnapshot: rabbit }))
  ;(VoipService as jest.Mock).mockImplementation(() => voip)
  expect((await restartSafety()).safe).toBe(true)
  expect(redis.disconnect).toHaveBeenCalledTimes(1)
  expect(voip.request).toHaveBeenCalledWith('/v1/console/backups/capability')
  rabbit.mockResolvedValueOnce({ overview: { queue_totals: { messages_unacknowledged: 1 } } })
  await expect(restartSafety()).rejects.toThrow('control_jobs_active')
  expect(redis.disconnect).toHaveBeenCalledTimes(2)
  redis.connect.mockRejectedValueOnce(new Error('redis unavailable'))
  await expect(restartSafety()).rejects.toThrow('control_safety_unavailable')
  expect(redis.disconnect).toHaveBeenCalledTimes(3)
})

test('storage preflight normalizes string SCAN cursors, ignores expired locks and terminates', async () => {
  const redis = { exists: jest.fn().mockResolvedValue(0), scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [] }) }
  await storageRestartSafety(redis)
  expect(redis.scan).toHaveBeenCalledTimes(4)
  redis.scan.mockResolvedValueOnce({ cursor: '1', keys: ['expired-lock'] })
  await storageRestartSafety(redis)
  expect(redis.scan).toHaveBeenCalledTimes(9)
})
test.each(['unoapi-session-storage:task:lock:1', 'unoapi-session-storage:migration-lock:worker', 'unoapi-session-storage:completion-lock:1', 'unoapi-session-storage:backup-scheduler-lock:1', 'unoapi-session-storage:standalone-job:1', 'unoapi-lease:voip-backup:main', 'unoapi-backup-rotation:voip:main'])('storage blocks %s', async key => {
  const redis = { exists: jest.fn(async (value: string) => value === key ? 1 : 0), scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [key] }) }
  await expect(storageRestartSafety(redis)).rejects.toThrow('control_storage_busy')
})
test('global Redis backup, scan budget and unknown state fail closed', async () => {
  await expect(storageRestartSafety({ exists: async () => 1, scan: jest.fn() })).rejects.toThrow('control_storage_busy')
  const scan = jest.fn().mockResolvedValue({ cursor: '1', keys: [] })
  await expect(storageRestartSafety({ exists: async () => 0, scan })).rejects.toThrow('control_safety_unavailable')
  expect(scan).toHaveBeenCalledTimes(300)
  await expect(storageRestartSafety({ exists: async () => 0, scan: async () => ({ cursor: 'bad', keys: [] }) })).rejects.toThrow('control_safety_unavailable')
})
test('native calls, router locks and Zapo calls are all guarded without exposing identities', () => {
  const state = { router: { locks: [] }, registrations: { webrtc: [], sipRtp: [] } }
  expect(() => voipRestartSafety({ calls: [] }, state, { restoring: false })).not.toThrow()
  expect(() => voipRestartSafety({ calls: [{ id: 'call' }] }, state, { restoring: false })).toThrow('control_calls_active')
  expect(() => voipRestartSafety({ calls: [] }, { ...state, router: { locks: [{}] } }, { restoring: false })).toThrow('control_calls_active')
  expect(() => voipRestartSafety({ calls: [] }, { ...state, registrations: { webrtc: [{ busy: true }], sipRtp: [] } }, { restoring: false })).toThrow('control_calls_active')
  expect(() => voipRestartSafety({ calls: [] }, { ...state, registrations: { webrtc: [], sipRtp: [{ busy: true }] } }, { restoring: false })).toThrow('control_calls_active')
  expect(() => voipRestartSafety({}, state, { restoring: false })).toThrow('control_safety_unavailable')
  expect(() => voipRestartSafety({ calls: [] }, state, { restoring: true })).toThrow('control_storage_busy')
  expect(() => voipRestartSafety({ calls: [] }, state, {})).toThrow('control_safety_unavailable')
})
