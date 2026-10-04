/** Live account inventory is independent of the SDK's local ADV epoch. */
export type CompanionInventoryRow = { deviceJid: string; keyIndex?: number; addedAtSeconds?: number; canRevoke: boolean }
type Inventory = (force?: boolean) => Promise<CompanionInventoryRow[]>
const inventories = new WeakMap<object, Inventory>()
export function companionInventory(mobile: object): Inventory | undefined { return inventories.get(mobile) }

export function installCompanionInventory(mobile: {
  reconcileCompanions(): Promise<readonly string[]>;
  listCompanions(): Promise<readonly { deviceJid: string; keyIndex: number; addedAtSeconds: number }[]>;
}, deps: {
  identity(): { meJid?: string; meLid?: string } | undefined;
  invalidate(jid: string): Promise<unknown>;
  sync(jids: string[]): Promise<readonly { jid: string; deviceJids: readonly string[] }[]>;
  current(): boolean;
}, now = Date.now) {
  const original = mobile.reconcileCompanions
  let pending: Promise<CompanionInventoryRow[]> | undefined, expires = 0, disposed = false, running = false
  const check = () => { if (disposed || !deps.current()) throw new Error('mobile_companion_inventory_not_connected') }
  const identity = () => {
    check()
    const value = deps.identity()
    if (!value?.meJid || !/^\d+(?::0)?@s\.whatsapp\.net$/.test(value.meJid)) throw new Error('mobile_companion_inventory_identity_missing')
    return { pn: value.meJid.replace(':0@', '@'), lid: value.meLid?.replace(':0@', '@') }
  }
  const invalidate = async () => {
    const own = identity()
    await deps.invalidate(own.pn)
    if (own.lid) await deps.invalidate(own.lid)
    check()
    return own
  }
  const reconcile = async () => {
    // The SDK's syncDeviceList normally returns a five-minute cache hit.
    // A pre-link snapshot must not prune a newly accepted companion.
    await invalidate()
    const result = await original.call(mobile)
    check(); pending = undefined; expires = 0
    return result
  }
  const inventory: Inventory = (force = false) => {
    check()
    if (pending && (running || !force && now() < expires)) return pending
    running = true
    expires = now() + 15000
    pending = (async () => {
      const own = await invalidate()
      const snapshots = await deps.sync([own.pn])
      check()
      const snapshot = snapshots.find(item => item.jid === own.pn)
      if (!snapshot) throw new Error('mobile_companion_inventory_unavailable')
      const tracked = await mobile.listCompanions()
      check()
      const rows = new Map<string, CompanionInventoryRow>()
      for (const jid of snapshot.deviceJids) {
        const match = /^(\d+):(\d+)@(s\.whatsapp\.net|lid)$/.exec(jid)
        if (!match || match[2] === '0') continue
        const user = `${match[1]}@${match[3]}`
        if (user !== own.pn && user !== own.lid) throw new Error('mobile_companion_inventory_scope_invalid')
        const deviceJid = `${own.pn.split('@')[0]}:${match[2]}@s.whatsapp.net`
        const record = tracked.find(item => item.deviceJid === deviceJid)
        rows.set(deviceJid, { deviceJid, ...(record ? { keyIndex: record.keyIndex, addedAtSeconds: record.addedAtSeconds } : {}), canRevoke: !!record })
        if (rows.size > 100) throw new Error('mobile_companion_inventory_capacity')
      }
      return [...rows.values()]
    })().catch(error => { pending = undefined; expires = 0; throw error }).finally(() => { running = false })
    return pending
  }
  mobile.reconcileCompanions = reconcile
  inventories.set(mobile, inventory)
  return () => {
    disposed = true; pending = undefined
    if (mobile.reconcileCompanions === reconcile) mobile.reconcileCompanions = original
    if (inventories.get(mobile) === inventory) inventories.delete(mobile)
  }
}
