import { createHash } from 'node:crypto'
import logger from '../logger'

/** Only this error permits another bootstrap attempt: no history was sent. */
export class HistoryPreparationError extends Error {
  constructor() { super('mobile_history_preparation_failed') }
}

export function historyErrorDiagnostic(error: unknown) {
  const value = error instanceof Error ? error : new Error('non_error')
  return {
    reason: /timeout|timed out/i.test(value.message) ? 'timeout' : 'provider_error',
    fingerprint: createHash('sha256').update(value.message).digest('hex').slice(0, 16),
    locations: [...(value.stack || '').matchAll(/[/\\]([A-Za-z0-9_-]+\.[jt]s):(\d+):(\d+)/g)]
      .slice(0, 6).map(match => `${match[1]}:${match[2]}:${match[3]}`),
  }
}

export async function prepareCompanionHistory(prepare: () => Promise<void>): Promise<void> {
  try { await prepare() } catch (error) {
    logger.warn({ ...historyErrorDiagnostic(error), stage: 'prepare', retryable: true }, 'MOBILE_COMPANION_HISTORY_ERROR')
    throw new HistoryPreparationError()
  }
}
