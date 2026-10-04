import type { WaStoreSession } from 'zapo-js'

const persistedSessionDomains = [
  'auth',
  'preKey',
  'session',
  'identity',
  'senderKey',
  'appState',
  'messages',
  'threads',
  'contacts',
  'privacyToken',
] as const

const expiringCacheDomains = [
  'retry',
  'groupMetadata',
  'chatMetadata',
  'deviceList',
  'messageSecret',
] as const

type SessionDomain = typeof persistedSessionDomains[number] | typeof expiringCacheDomains[number] | 'signal'

export type ZapoSessionCleanupResult = {
  cacheFailures: Array<{ domain: SessionDomain; error: unknown }>
}

const isAlreadyDestroyedCache = (error: unknown) => (
  error instanceof Error && error.message === 'shared-exclusive gate is closed'
)

const clearDomains = async (session: WaStoreSession, domains: readonly SessionDomain[]) => {
  const results = await Promise.allSettled(domains.map(async (domain) => session[domain].clear()))
  return results.flatMap((result, index) => (
    result.status === 'rejected' && !isAlreadyDestroyedCache(result.reason)
      ? [{ domain: domains[index], error: result.reason }]
      : []
  ))
}

export async function clearZapoSession(session: WaStoreSession) {
  const persistedFailures = await clearDomains(session, persistedSessionDomains)
  // Redis preKey.clear() recreates signal:meta with empty counters. Clear signal
  // after all prekey work, otherwise a full deletion leaves crypto metadata behind.
  persistedFailures.push(...await clearDomains(session, ['signal']))
  const cacheFailures = await clearDomains(session, expiringCacheDomains)

  await session.destroyCaches()

  if (persistedFailures.length) {
    throw new Error(`zapo_session_clear_failed: ${persistedFailures.map(({ domain }) => domain).join(',')}`)
  }

  return { cacheFailures } satisfies ZapoSessionCleanupResult
}
