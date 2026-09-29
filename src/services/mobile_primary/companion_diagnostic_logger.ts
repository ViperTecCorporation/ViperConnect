import { createHash } from 'node:crypto'
import type { WaClient } from 'zapo-js'
import logger from '../logger'

type SdkLogger = NonNullable<ConstructorParameters<typeof WaClient>[1]>
const events: Record<string, string> = {
  'seeded primary setting_pushName into critical_block app-state': 'PUSH_NAME_SEEDED',
  'failed to seed primary setting_pushName app-state': 'PUSH_NAME_FAILED',
  'companion provisioned': 'PROVISIONED',
  'companion provisioning failed': 'PROVISION_FAILED',
  'companion provisioning attempt failed': 'PROVISION_ATTEMPT_FAILED',
  'companion app-state key share (best-effort) failed': 'KEY_SHARE_FAILED',
}

/** Exact allowlist: never forward SDK context, bindings or error text to diagnostics. */
export function companionDiagnosticLogger(base: SdkLogger, enabled: boolean, session: string): SdkLogger {
  if (!enabled) return base
  const sessionHash = createHash('sha256').update(session).digest('hex').slice(0, 16)
  const observe = (message: string, context?: Readonly<Record<string, unknown>>) => {
    const event = Object.prototype.hasOwnProperty.call(events, message) ? events[message] : undefined
    if (!event) return
    const target = context?.deviceJid
    logger.info({ sessionHash, event,
      targetHash: typeof target === 'string' ? createHash('sha256').update(target).digest('hex').slice(0, 16) : undefined,
      attempt: typeof context?.attempt === 'number' ? context.attempt : undefined,
      attempts: typeof context?.attempts === 'number' ? context.attempts : undefined,
    }, 'MOBILE_COMPANION_SDK_DIAGNOSTIC')
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
