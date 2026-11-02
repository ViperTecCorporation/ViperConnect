import { createHash } from 'node:crypto'
import logger from '../logger'

/** Only this error permits another bootstrap attempt: no history was sent. */
export class HistoryPreparationError extends Error {
  constructor() { super('mobile_history_preparation_failed') }
}

export function historyErrorDiagnostic(error: unknown) {
  const value = error instanceof Error ? error : new Error('non_error')
  const iq = /^key bundle iq failed \((\d{3}): ([a-z-]+)\)$/.exec(value.message)
  return {
    reason: /timeout|timed out/i.test(value.message) ? 'timeout' : 'provider_error',
    ...(iq ? { providerCode: Number(iq[1]), providerReason: iq[2] === 'not-acceptable' ? 'not-acceptable' : 'redacted' } : {}),
    fingerprint: createHash('sha256').update(value.message).digest('hex').slice(0, 16),
    locations: [...(value.stack || '').matchAll(/[/\\]([A-Za-z0-9_-]+\.[jt]s):(\d+):(\d+)/g)]
      .slice(0, 6).map(match => `${match[1]}:${match[2]}:${match[3]}`),
  }
}

export async function prepareCompanionHistory(
  prepare: () => Promise<void>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  // A newly linked device may not have published its prekeys yet. Retry only
  // this exact rejection, before bootstrap/key publication, never a send.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await prepare(); return } catch (error) {
      const transient = error instanceof Error && error.message === 'key bundle iq failed (406: not-acceptable)'
      const retrying = transient && attempt < 3
      logger.warn({ ...historyErrorDiagnostic(error), stage: 'prepare', attempt, retryable: true, retrying }, 'MOBILE_COMPANION_HISTORY_ERROR')
      if (!retrying) throw new HistoryPreparationError()
      await wait(attempt * 1500)
    }
  }
}
