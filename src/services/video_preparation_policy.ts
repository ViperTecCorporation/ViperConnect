import type { getConfig } from './config'
import { NonRetryableQueueError } from './non_retryable_queue_error'
import { readSessionLifecycleConfig } from './session_storage/lifecycle_transition'
import { SendError } from './send_error'

export async function readVideoPreparationConfig(phone: string, read: getConfig, expected?: string) {
  try { return await readSessionLifecycleConfig(phone, read, expected) }
  catch (error) {
    if (error instanceof SendError && error.title === 'session_storage_fixture_external_effects_forbidden') {
      throw new NonRetryableQueueError(error)
    }
    throw error
  }
}

/** Policy refusals must not emit failed statuses/webhooks from quarantined data. */
export const isVideoPreparationPolicyRefusal = (error: unknown) => [
  'session_storage_fixture_external_effects_forbidden',
  'session_storage_operation_in_progress', 'session_storage_generation_changed',
].includes(`${(error as { title?: string })?.title || (error as { code?: string })?.code || ''}`)
