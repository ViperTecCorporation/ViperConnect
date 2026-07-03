import logger from './logger'
import { getAuth, setAuth } from './redis'

export const preparePrivacyBootstrapSync = async (phone: string): Promise<{
  updated: boolean
  previous_account_sync_counter?: number
  previous_processed_history_messages?: number
}> => {
  const credsKey = `${phone}:creds`
  const creds = await getAuth(credsKey)
  if (!creds || typeof creds !== 'object') {
    return { updated: false }
  }

  const previousAccountSyncCounter = Number.isFinite(Number((creds as any).accountSyncCounter))
    ? Number((creds as any).accountSyncCounter)
    : undefined
  const previousProcessedHistoryMessages = Array.isArray((creds as any).processedHistoryMessages)
    ? (creds as any).processedHistoryMessages.length
    : undefined

  ;(creds as any).accountSyncCounter = 0
  ;(creds as any).processedHistoryMessages = []

  await setAuth(credsKey, creds)
  try {
    logger.warn(
      'Prepared privacy bootstrap sync for %s: accountSyncCounter %s -> 0, processedHistoryMessages %s -> 0',
      phone,
      previousAccountSyncCounter ?? '<none>',
      previousProcessedHistoryMessages ?? '<none>',
    )
  } catch {}

  return {
    updated: true,
    previous_account_sync_counter: previousAccountSyncCounter,
    previous_processed_history_messages: previousProcessedHistoryMessages,
  }
}
