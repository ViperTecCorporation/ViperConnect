import { createHash, randomUUID } from 'node:crypto'
import logger from '../logger'
import { historyErrorDiagnostic } from './companion_history_prepare'

/** Observe the SDK's own call, without sending keys, retrying or changing errors. */
export function traceCompanionKeyShare(mobile: { shareAppStateSyncKeys(target: string): Promise<void> }, device: string) {
  const original = mobile.shareAppStateSyncKeys
  if (typeof original !== 'function') throw new Error('mobile_key_share_trace_unsupported')
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const replacement = async function (this: typeof mobile, target: string): Promise<void> {
    const started = Date.now()
    const fields = { device, traceId: randomUUID(), targetHash: createHash('sha256').update(target).digest('hex').slice(0, 16), stage: 'app_state_key_share' }
    logger.info(fields, 'MOBILE_COMPANION_KEY_SHARE_STARTED')
    const timer = setTimeout(() => {
      timers.delete(timer)
      logger.warn({ ...fields, elapsedMs: Date.now() - started }, 'MOBILE_COMPANION_KEY_SHARE_PENDING')
    }, 15000)
    timer.unref(); timers.add(timer)
    try {
      await original.call(this, target)
      logger.info({ ...fields, elapsedMs: Date.now() - started }, 'MOBILE_COMPANION_KEY_SHARE_SUBMITTED')
    } catch (error) {
      logger.warn({ ...fields, elapsedMs: Date.now() - started, diagnostic: historyErrorDiagnostic(error) }, 'MOBILE_COMPANION_KEY_SHARE_FAILED')
      throw error
    } finally { clearTimeout(timer); timers.delete(timer) }
  }
  mobile.shareAppStateSyncKeys = replacement
  return () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (mobile.shareAppStateSyncKeys === replacement) mobile.shareAppStateSyncKeys = original
  }
}
