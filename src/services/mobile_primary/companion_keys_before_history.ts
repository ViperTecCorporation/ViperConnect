/** Lab experiment: await the existing key-share method before history and
 * consume the SDK's subsequent call once. A failed/uncertain share is not retried. */
export function keysBeforeHistory(mobile: { shareAppStateSyncKeys(target: string): Promise<void> }) {
  const original = mobile.shareAppStateSyncKeys
  const pending = new Map<string, Promise<void>>()
  const share = (target: string) => {
    let result = pending.get(target)
    if (!result) {
      if (pending.size >= 100) throw new Error('mobile_key_share_capacity')
      result = Promise.resolve().then(() => original.call(mobile, target))
      pending.set(target, result)
    }
    return result
  }
  const replacement = async (target: string) => {
    const result = pending.get(target)
    if (!result) return original.call(mobile, target)
    await result
    // Key share was already submitted. Do not send it twice in provisioning.
    if (pending.get(target) === result) pending.delete(target)
  }
  mobile.shareAppStateSyncKeys = replacement
  return { share, dispose() {
    if (mobile.shareAppStateSyncKeys === replacement) mobile.shareAppStateSyncKeys = original
    pending.clear()
  } }
}
