import type { Logger } from 'zapo-js'
const failures = new Set<string>()
export const beginStorageDrain = (phone: string) => { failures.delete(phone) }
export const finishStorageDrain = (phone: string) => { const clean = !failures.has(phone); failures.delete(phone); return clean }

/** Observe the public SDK logger contract, never inspect private write-behind fields. */
export function observeStorageDrain(logger: Logger, phone: string): Logger {
  return new Proxy(logger, { get(target, property) {
    const value = Reflect.get(target, property)
    if (property === 'child' && typeof value === 'function') return (...args: unknown[]) => observeStorageDrain(value.apply(target, args), phone)
    if (property === 'warn' && typeof value === 'function') return (message: string, ...args: unknown[]) => {
      if (message === 'disconnect continuing with pending write-behind entries') failures.add(phone)
      return value.call(target, message, ...args)
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
