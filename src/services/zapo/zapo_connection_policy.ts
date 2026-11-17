import type { WaClientOptions } from 'zapo-js'
import { ZAPO_WEB_VERSION } from '../../defaults'
import { SendError } from '../send_error'

// ViperConnect owns the initial version; the SDK may recover an outdated version.
// Verified against WhatsApp's public sw.js on 2026-11-16. Mobile TCP continues
// to use deviceInfo.appVersion; this version is the Web companion version.
export const VIPERCONNECT_ZAPO_CONNECTION_POLICY = Object.freeze({
  version: '2.3000.1054816457',
  recoverFromClientTooOld: true,
} satisfies Pick<WaClientOptions, 'version' | 'recoverFromClientTooOld'>)

/** Empty explicitly means inherit. Never interpret a URL, resolver or array. */
export function normalizeZapoWebVersion(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new SendError(400, 'zapo_web_version_invalid')
  const version = value.trim()
  if (!version) return ''
  if (!/^\d+(?:\.\d+){2,4}$/.test(version) || version.length > 54
    || version.split('.').some(part => !Number.isSafeInteger(Number(part)) || Number(part) > 0xffffffff)) {
    throw new SendError(400, 'zapo_web_version_invalid')
  }
  return version
}

/** The owning worker resolves its ENV, not the web process's environment. */
export function resolveZapoConnectionPolicy(mobile: boolean, sessionVersion?: unknown, workerVersion: unknown = ZAPO_WEB_VERSION): {
  recoverFromClientTooOld: boolean; version?: string
} {
  // SDK 1.11.0's mobile recovery fetches Android versions even for iOS credentials.
  // This feature is a Web override; keep native registration policy unchanged.
  if (mobile) return { recoverFromClientTooOld: false }
  const version = normalizeZapoWebVersion(sessionVersion) || normalizeZapoWebVersion(workerVersion) || VIPERCONNECT_ZAPO_CONNECTION_POLICY.version
  return { version, recoverFromClientTooOld: true }
}
