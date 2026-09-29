/** Preserve native bootstrap -> keys. Queue history only after both succeed.
 * A history queue failure must never cause the SDK to repeat provisioning. */
export function historyAfterProvision(mobile: {
  sendHistorySyncBootstrap(target: string, options?: any): Promise<void>
  shareAppStateSyncKeys(target: string): Promise<void>
  listCompanions(): Promise<readonly { deviceJid: string; keyIndex: number }[]>
}, enqueue: (target: string) => Promise<void>, onError: (error: unknown) => void,
  sendSnapshot?: (target: string) => Promise<boolean>) {
  const bootstrap = mobile.sendHistorySyncBootstrap, keys = mobile.shareAppStateSyncKeys
  const initialized = new Set<string>(), scheduled = new Set<string>()
  let active = true
  const wrappedBootstrap = async (target: string, options?: any) => {
    if (!sendSnapshot || !await sendSnapshot(target)) await bootstrap.call(mobile, target, options)
    if (active && initialized.size < 100) initialized.add(target)
  }
  const wrappedKeys = async (target: string) => {
    await keys.call(mobile, target)
    if (!active || !initialized.has(target)) return
    try {
      const companion = (await mobile.listCompanions()).find(item => item.deviceJid === target)
      if (!active || !companion) return
      const identity = `${target}:${companion.keyIndex}`
      if (scheduled.has(identity)) return
      if (scheduled.size >= 100) throw new Error('mobile_history_provision_capacity')
      scheduled.add(identity) // Ambiguous enqueue must not publish twice.
      await enqueue(target)
    } catch (error) { onError(error) }
  }
  mobile.sendHistorySyncBootstrap = wrappedBootstrap
  mobile.shareAppStateSyncKeys = wrappedKeys
  return () => {
    active = false
    if (mobile.sendHistorySyncBootstrap === wrappedBootstrap) mobile.sendHistorySyncBootstrap = bootstrap
    if (mobile.shareAppStateSyncKeys === wrappedKeys) mobile.shareAppStateSyncKeys = keys
    initialized.clear(); scheduled.clear()
  }
}
