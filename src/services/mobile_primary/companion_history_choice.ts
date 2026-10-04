type Choice = { pending?: boolean; targets: Map<string, boolean> }
const choices = new WeakMap<object, Choice>()

function state(mobile: object): Choice {
  let value = choices.get(mobile)
  if (!value) { value = { targets: new Map() }; choices.set(mobile, value) }
  return value
}

/** The SDK starts background provisioning before the linking promise resolves. */
export async function withCompanionHistoryChoice<T>(mobile: object, enabled: boolean, link: () => Promise<T>): Promise<T> {
  const value = state(mobile)
  if (value.pending !== undefined) throw new Error('mobile_companion_busy')
  value.pending = enabled
  try { return await link() } finally { value.pending = undefined }
}

/** Snapshot before any await; keep the choice for retries of this device/key index. */
export function captureCompanionHistoryChoice(mobile: object) {
  const value = state(mobile), pending = value.pending
  return (target: string, keyIndex: number): boolean => {
    const key = `${target}:${keyIndex}`
    if (pending !== undefined) {
      for (const old of value.targets.keys()) if (old.startsWith(`${target}:`) && old !== key) value.targets.delete(old)
      if (!value.targets.has(key) && value.targets.size >= 100) throw new Error('mobile_history_choice_capacity')
      value.targets.set(key, pending)
    }
    return value.targets.get(key) ?? true
  }
}
