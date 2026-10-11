import { createHash } from 'node:crypto'
import type { WaClient } from 'zapo-js'
import logger from '../logger'
import { safeCompanionPlatform } from './companion_trace_fields'

type SdkLogger = NonNullable<ConstructorParameters<typeof WaClient>[1]>
const events: Record<string, string> = {
  'seeded primary setting_pushName into critical_block app-state': 'PUSH_NAME_SEEDED',
  'failed to seed primary setting_pushName app-state': 'PUSH_NAME_FAILED',
  'companion provisioned': 'PROVISIONED',
  'companion provisioning failed': 'PROVISION_FAILED',
  'companion provisioning attempt failed': 'PROVISION_ATTEMPT_FAILED',
  'companion app-state key share (best-effort) failed': 'KEY_SHARE_FAILED',
  'linking companion': 'LINK_STARTED',
  'companion linked': 'LINK_ACCEPTED',
  'companion link failed': 'LINK_FAILED',
  'companion link-by-code failed': 'CODE_LINK_FAILED',
  'shared app-state sync key with companion': 'APP_STATE_KEY_SUBMITTED',
  'companion-host history sync bootstrap sent': 'BOOTSTRAP_SUBMITTED',
  'reconciled companions with server device list': 'INVENTORY_RECONCILED',
  'account device key-indexes updated': 'KEY_INDEXES_UPDATED',
  'recorded link-code companion_hello': 'CODE_HELLO_RECEIVED',
  'companion revoked': 'REVOKED',
}

/** Exact allowlist: never forward SDK context, bindings or error text to diagnostics. */
export function companionDiagnosticLogger(base: SdkLogger, enabled: boolean, session: string): SdkLogger {
  if (!enabled) return base
  const sessionHash = createHash('sha256').update(session).digest('hex').slice(0, 16)
  const observe = (message: string, context?: Readonly<Record<string, unknown>>) => {
    const event = Object.prototype.hasOwnProperty.call(events, message) ? events[message] : undefined
    if (!event) return
    const target = context?.deviceJid
    const fields: Record<string, unknown> = {}
    for (const name of ['attempt', 'attempts', 'keyIndex', 'kept', 'removed', 'mappings', 'payloadBytes']) {
      const value = context?.[name]
      if (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647) fields[name] = value
    }
    if (message === 'linking companion') fields.platform = safeCompanionPlatform(context?.platform)
    if (message === 'account device key-indexes updated' && Array.isArray(context?.indexes)) fields.indexCount = context.indexes.length
    try { logger.info({ sessionHash, event, ...fields,
      targetHash: typeof target === 'string' ? createHash('sha256').update(target).digest('hex').slice(0, 16) : undefined,
    }, 'MOBILE_COMPANION_SDK_DIAGNOSTIC') } catch { /* diagnostics must not affect protocol */ }
  }
  return {
    level: base.level,
    trace: (message, context) => { observe(message, context); base.trace(message, context) },
    debug: (message, context) => { observe(message, context); base.debug(message, context) },
    info: (message, context) => { observe(message, context); base.info(message, context) },
    warn: (message, context) => { observe(message, context); base.warn(message, context) },
    error: (message, context) => { observe(message, context); base.error(message, context) },
    child: (bindings, options) => companionDiagnosticLogger(base.child(bindings, options), true, session),
  }
}
