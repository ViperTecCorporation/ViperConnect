import { isDeepStrictEqual } from 'node:util'
import type { Config } from './config'

/** Compare effective config, including full-form register requests. */
export const isWebhookOnlyUpdate = (before: Config, after: Config): boolean => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (key === 'webhooks' || key === 'overrideWebhooks' || key === 'getMessageMetadata') continue
    if (typeof before[key] === 'function' && typeof after[key] === 'function') continue
    if (!isDeepStrictEqual(before[key], after[key])) return false
  }
  return true
}
