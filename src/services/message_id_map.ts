import type { DataStore } from './data_store'

type IdStore = Pick<DataStore, 'loadUnoId' | 'loadProviderId'>

const resolveChain = async (
  initial: string,
  next: (id: string) => Promise<string | undefined>,
  maxDepth = 8,
) => {
  let current = `${initial || ''}`.trim()
  const seen = new Set<string>()
  for (let depth = 0; current && depth < maxDepth; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    const candidate = `${await next(current) || ''}`.trim()
    if (!candidate || candidate === current) break
    if (seen.has(candidate)) break
    current = candidate
  }
  return current || undefined
}

export const resolveUnoMessageId = (store: IdStore, providerId: string) =>
  resolveChain(providerId, (id) => store.loadUnoId(id))

export const resolveProviderMessageId = (store: IdStore, unoId: string) =>
  resolveChain(unoId, (id) => store.loadProviderId(id))
