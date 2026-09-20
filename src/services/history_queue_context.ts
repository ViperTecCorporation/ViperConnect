import { AsyncLocalStorage } from 'node:async_hooks'

// Transport context only: never add internal routing fields to webhook payloads.
const historyContext = new AsyncLocalStorage<boolean>()

export const withHistoryQueue = <T>(operation: () => T): T => historyContext.run(true, operation)
export const isHistoryQueue = (): boolean => historyContext.getStore() === true
