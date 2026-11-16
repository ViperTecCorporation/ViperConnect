import type { SessionConfig, SessionStatus } from './types.js'
import { t } from '../core/i18n.js'

const phoneCandidates = (session: SessionConfig): unknown[] => [
  session.id,
  session.phone,
  session.session_phone,
  session.display_phone_number,
]

export const sessionPhone = (session: SessionConfig): string =>
  `${phoneCandidates(session).find((value) => `${value ?? ''}`.trim()) ?? ''}`.replace(/\D/g, '')

export const sessionLabel = (session: SessionConfig): string =>
  `${session.label || sessionPhone(session) || t('Sessão sem identificação')}`

export const normalizedStatus = (status: SessionStatus | undefined): string =>
  `${status || 'offline'}`.trim().toLowerCase()

export const isOnlineStatus = (status: SessionStatus | undefined): boolean =>
  normalizedStatus(status) === 'online'

export const isConnectingStatus = (status: SessionStatus | undefined): boolean =>
  normalizedStatus(status) === 'connecting'

export const isLegacySession = (session: SessionConfig): boolean =>
  session.provider === 'baileys' || session.provider === 'forwarder'

export const isSessionStorageFixture = (session: SessionConfig | undefined): boolean => {
  const descriptor = session?.sessionStorage as { fixture?: boolean } | undefined
  return descriptor?.fixture === true || session?.fixture === true
}

export const filterSessions = (
  sessions: SessionConfig[],
  query: string,
  status: string,
): SessionConfig[] => {
  const needle = query.trim().toLowerCase()
  const wantedStatus = status.trim().toLowerCase()
  return sessions.filter((session) => {
    const matchesText = !needle
      || sessionLabel(session).toLowerCase().includes(needle)
      || sessionPhone(session).includes(needle)
    const currentStatus = normalizedStatus(session.status)
    const matchesStatus = !wantedStatus || wantedStatus === 'all'
      || currentStatus === wantedStatus
      || (wantedStatus === 'offline' && currentStatus === 'disconnected')
    return matchesText && matchesStatus
  })
}
