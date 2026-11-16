import { createClient } from '@redis/client'
import { AMQP_URL, REDIS_URL } from '../../defaults'
import { RabbitManagement } from '../rabbitmq_management'
import { VoipService } from '../voip_service'
import { ServiceControlError } from './types'

interface SafetyRedis {
  exists(key: string): Promise<number>
  scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number | string; keys: string[] }>
}
const lockPatterns = ['unoapi-session-storage:*lock*', 'unoapi-session-storage:standalone-job:*', 'unoapi-lease:voip-backup:*', 'unoapi-backup-rotation:*']

export async function storageRestartSafety(redis: SafetyRedis, now = Date.now) {
  if (await redis.exists('unoapi-infrastructure:redis-backup:running')) throw new ServiceControlError(423, 'control_storage_busy')
  const deadline = now() + 2500; let pages = 0
  for (const pattern of lockPatterns) {
    let cursor = 0
    do {
      if (++pages > 300 || now() > deadline) throw new ServiceControlError(423, 'control_safety_unavailable')
      const page = await redis.scan(cursor, { MATCH: pattern, COUNT: 1000 }); cursor = Number(page.cursor)
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(page.keys)) throw new ServiceControlError(423, 'control_safety_unavailable')
      for (const key of page.keys) if (await redis.exists(key)) throw new ServiceControlError(423, 'control_storage_busy')
    } while (cursor !== 0)
  }
}

/** Also includes native extension-to-extension calls, not only the Zapo call list. */
export function voipRestartSafety(calls: any, consoleState: any, backup: any) {
  if (!Array.isArray(calls?.calls) || !Array.isArray(consoleState?.router?.locks)
    || !Array.isArray(consoleState?.registrations?.webrtc) || !Array.isArray(consoleState?.registrations?.sipRtp)
    || typeof backup?.restoring !== 'boolean') throw new ServiceControlError(423, 'control_safety_unavailable')
  if (backup.restoring) throw new ServiceControlError(423, 'control_storage_busy')
  if (calls.calls.length || consoleState.router.locks.length || [...consoleState.registrations.webrtc, ...consoleState.registrations.sipRtp].some(row => row.busy === true)) throw new ServiceControlError(423, 'control_calls_active')
}

export async function restartSafety() {
  const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true, socket: { connectTimeout: 2000, reconnectStrategy: false } })
  redis.on('error', () => undefined)
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ServiceControlError(423, 'control_safety_unavailable')), 10000) }), (async () => {
      await redis.connect()
      await storageRestartSafety(redis)
      const voip = new VoipService(undefined, undefined, 5000)
      if (voip.available()) {
        const [calls, state, backup] = await Promise.all([voip.request('/v1/zapo/calls'), voip.request('/v1/console/bootstrap'), voip.request('/v1/console/backups/capability')])
        voipRestartSafety(calls, state, backup)
      }
      if (AMQP_URL) {
        const snapshot = await new RabbitManagement().resourceSnapshot(), unacked = snapshot.overview?.queue_totals?.messages_unacknowledged
        if (!Number.isSafeInteger(unacked) || unacked < 0) throw new ServiceControlError(423, 'control_safety_unavailable')
        if (unacked > 0) throw new ServiceControlError(423, 'control_jobs_active')
      }
    })()])
    return { safe: true as const, checkedAt: Date.now() }
  } catch (error) { throw error instanceof ServiceControlError ? error : new ServiceControlError(423, 'control_safety_unavailable') }
  finally { clearTimeout(timer); if (redis.isOpen) await redis.disconnect().catch(() => undefined) }
}
