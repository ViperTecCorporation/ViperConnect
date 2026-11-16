import { configs } from '../config'
import { SendError } from '../send_error'
const active = new Map<string, number>()
const quiescing = new Set<string>()
export const beginSessionStorageQuiesce = (phone: string) => { quiescing.add(phone) }
export const endSessionStorageQuiesce = (phone: string) => { quiescing.delete(phone) }
export const hasSessionStorageActivity = (phone: string) => quiescing.has(phone) || (active.get(phone) || 0) > 0
export async function withSessionStorageActivity<T>(phone: string, run: () => Promise<T>): Promise<T> {
  if (quiescing.has(phone) || ['migrating', 'restoring'].includes(configs.get(phone)?.sessionStorage?.state || '')) throw new SendError(503, 'session_storage_operation_in_progress')
  active.set(phone, (active.get(phone) || 0) + 1)
  try { return await run() } finally { const n = (active.get(phone) || 1) - 1; if (n) active.set(phone, n); else active.delete(phone) }
}
export async function waitSessionStorageIdle(phone: string, timeout = 30000) {
  const start = Date.now()
  while (active.get(phone)) { if (Date.now() - start >= timeout) throw new SendError(409, 'session_storage_inflight_operations'); await new Promise(resolve => setTimeout(resolve, 25)) }
}
