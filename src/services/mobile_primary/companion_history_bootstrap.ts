/** Version-scoped interception of Zapo 1.9.0's INITIAL bootstrap entry point.
 * SDK provisioning calls this method BEFORE sharing app-state keys. Do not use
 * companion_host_linked as a second sender: that races the SDK's empty bootstrap.
 */
import { HistoryPreparationError } from './companion_history_prepare'

export function installHistoryBootstrap(
  mobile: { sendHistorySyncBootstrap(target: string, options?: any): Promise<void>; listCompanions(): Promise<readonly { deviceJid: string; keyIndex: number }[]> },
  send: (target: string) => Promise<'submitted' | 'empty' | 'native-bootstrap'>,
) {
  const original = mobile.sendHistorySyncBootstrap
  if (typeof original !== 'function') throw new Error('mobile_history_bootstrap_unsupported')
  const attempts = new Map<string, Promise<void>>()
  const replacement = async (target: string, options?: any) => {
    const companion = (await mobile.listCompanions()).find(c => c.deviceJid === target)
    if (!companion) throw new Error('mobile_history_companion_missing')
    const key = `${target}:${companion.keyIndex}`
    let pending = attempts.get(key)
    if (!pending) {
      if (attempts.size >= 100) throw new Error('mobile_history_bootstrap_capacity')
      pending = (async () => {
        const result = await send(target)
        // An empty local archive still needs the SDK's normal initial gate.
        if (result === 'empty' || result === 'native-bootstrap') await original.call(mobile, target, options)
      })()
      attempts.set(key, pending)
    }
    try { await pending } catch (error) {
      // Release only preparation failures; retain ambiguous sends to avoid replay.
      if (error instanceof HistoryPreparationError && attempts.get(key) === pending) attempts.delete(key)
      throw error
    }
  }
  mobile.sendHistorySyncBootstrap = replacement
  return () => { if (mobile.sendHistorySyncBootstrap === replacement) mobile.sendHistorySyncBootstrap = original }
}
