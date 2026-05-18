import makeWASocket, {
  DisconnectReason,
  WABrowserDescription,
  WAMessageKey,
  delay,
  proto,
  WASocket,
  AnyMessageContent,
  BaileysEventMap,
  GroupMetadata,
  Browsers,
  ConnectionState,
  UserFacingSocketConfig,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  isLidUser,
  isPnUser,
  WAMessageAddressingMode,
} from '@whiskeysockets/baileys'
import type { BinaryNode } from '@whiskeysockets/baileys'
import MAIN_LOGGER from '@whiskeysockets/baileys/lib/Utils/logger'
import { Config, defaultConfig } from './config'
import { Store } from './store'
import { isIndividualJid, isValidPhoneNumber, jidToPhoneNumber, phoneNumberToJid, ensurePn, normalizeTransportJid } from './transformer'
import logger from './logger'
import { Level } from 'pino'
import { SocksProxyAgent } from 'socks-proxy-agent'
import {
  DEFAULT_BROWSER,
  LOG_LEVEL,
  CONNECTING_TIMEOUT_MS,
  BAILEYS_IDLE_RECONNECT_ENABLED,
  BAILEYS_IDLE_RECONNECT_MS,
  BAILEYS_IDLE_RECONNECT_CHECK_MS,
  MAX_CONNECT_TIME,
  MAX_CONNECT_RETRY,
  CLEAN_CONFIG_ON_DISCONNECT,
  VALIDATE_SESSION_NUMBER,
  QR_POST_LOGIN_SUPPRESS_MS,
} from '../defaults'
import { ACK_RETRY_DELAYS_MS, ACK_RETRY_MAX_ATTEMPTS, ACK_RETRY_ENABLED } from '../defaults'
import { SELFHEAL_ASSERT_ON_DECRYPT, PERIODIC_ASSERT_ENABLED, PERIODIC_ASSERT_INTERVAL_MS, PERIODIC_ASSERT_MAX_TARGETS, PERIODIC_ASSERT_RECENT_WINDOW_MS, PERIODIC_ASSERT_FORCE, PERIODIC_ASSERT_INCLUDE_GROUPS } from '../defaults'
import { ONE_TO_ONE_ADDRESSING_MODE, BR_SEND_ORDER_ENABLED } from '../defaults'
import { STATUS_ALLOW_LID, GROUP_SEND_PREASSERT_SESSIONS } from '../defaults'
import { GROUP_ASSERT_CHUNK_SIZE, GROUP_ASSERT_FLOOD_WINDOW_MS, NO_SESSION_RETRY_BASE_DELAY_MS, NO_SESSION_RETRY_PER_200_DELAY_MS, NO_SESSION_RETRY_MAX_DELAY_MS, RECEIPT_RETRY_ASSERT_COOLDOWN_MS, RECEIPT_RETRY_ASSERT_MAX_TARGETS, GROUP_LARGE_THRESHOLD } from '../defaults'
import {
  DELIVERY_WATCHDOG_ENABLED,
  DELIVERY_WATCHDOG_MS,
  DELIVERY_WATCHDOG_MAX_ATTEMPTS,
  DELIVERY_WATCHDOG_GROUPS,
  DELIVERY_STALE_RECOVERY_ENABLED,
  DELIVERY_STALE_RECOVERY_MS,
  DELIVERY_STALE_RECOVERY_SCAN_MS,
  DELIVERY_STALE_RECOVERY_MAX_ATTEMPTS,
  DELIVERY_STALE_RECOVERY_MAX_PENDING,
  DELIVERY_STALE_RECOVERY_BATCH_SIZE,
  DELIVERY_STALE_RECOVERY_GROUPS,
} from '../defaults'
import { SESSION_DIR } from './session_store_file'
import { BASE_KEY, redisGet, redisSetAndExpire, delSignalSessionsForJids, countSignalSessionsForJids, enrichJidMapFromAuthLidCache, configKey, getLidForPnFromAuthCache, getPnForLidFromAuthCache, getHistorySyncMarker, setHistorySyncMarker } from './redis'
import { readdirSync, rmSync } from 'fs'
import { STATUS_BROADCAST_ENABLED } from '../defaults'
import { LID_RESOLVER_ENABLED, LID_RESOLVER_BACKOFF_MS, LID_RESOLVER_SWEEP_INTERVAL_MS, LID_RESOLVER_MAX_PENDING } from '../defaults'
import { JIDMAP_ENRICH_ENABLED, JIDMAP_ENRICH_PER_SWEEP, JIDMAP_ENRICH_AUTH_ENABLED } from '../defaults'
import { SIGNAL_SESSION_PURGE_ENABLED } from '../defaults'
import { GROUP_SEND_FALLBACK_ORDER } from '../defaults'
import {
  ONE_TO_ONE_PREASSERT_ENABLED,
  ONE_TO_ONE_PREASSERT_COOLDOWN_MS,
  ONE_TO_ONE_PREASSERT_REDIS_TTL_SEC,
  ONE_TO_ONE_ASSERT_PROBE_ENABLED,
  ONE_TO_ONE_PREASSERT_PURGE_DEVICE_LIST,
  SIGNAL_CACHE_SAFE_MODE,
} from '../defaults'
import { t } from '../i18n'
import { SendError } from './send_error'

export const historySyncTypeName = (syncType: proto.HistorySync.HistorySyncType | undefined): string => {
  return typeof syncType === 'number'
    ? proto.HistorySync.HistorySyncType[syncType] || `${syncType}`
    : `${syncType || 'unknown'}`
}

export const shouldAcceptHistorySync = (
  syncType: proto.HistorySync.HistorySyncType | undefined,
  config: Pick<Partial<Config>, 'ignoreHistoryMessages' | 'allowFullHistorySync'>,
  state: { historyAlreadySynced?: boolean; historySyncInProgress?: boolean } = {},
): boolean => {
  if (syncType === undefined) return false
  if (syncType === proto.HistorySync.HistorySyncType.PUSH_NAME) return true
  if (config.ignoreHistoryMessages) return false
  if (syncType === proto.HistorySync.HistorySyncType.RECENT) return true
  if (state.historySyncInProgress) return true
  if (state.historyAlreadySynced && !config.allowFullHistorySync) return false
  return [
    proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.HistorySync.HistorySyncType.ON_DEMAND,
    proto.HistorySync.HistorySyncType.FULL,
  ].includes(syncType)
}

const EVENTS = [
  'connection.update',
  'creds.update',
  'messaging-history.set',
  'chats.upsert',
  'chats.update',
  'chats.phoneNumberShare',
  'chats.delete',
  'presence.update',
  'contacts.upsert',
  'contacts.update',
  'messages.delete',
  'messages.update',
  'messages.media-update',
  'messages.upsert',
  'messages.reaction',
  'message-receipt.update',
  'groups.upsert',
  'groups.update',
  'group-participants.update',
  'blocklist.set',
  'blocklist.update',
  'call',
  'labels.edit',
  'labels.association',
  'offline.preview',
  'lid-mapping.update',
]

export type OnQrCode = (qrCode: string, time: number, limit: number) => Promise<void>
export type OnNotification = (text: string, important: boolean) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnDisconnected = (phone: string, payload: any) => Promise<void>
export type OnNewLogin = (phone: string) => Promise<void>
export type OnReconnect = (time: number) => Promise<void>

export interface sendMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (_phone: string, _message: AnyMessageContent, _options: unknown): Promise<any>
}

export interface readMessages {
  (_keys: WAMessageKey[]): Promise<boolean>
}

const normalizeReceiptJid = (jid?: string | null): string | undefined => {
  const raw = `${jid || ''}`.trim()
  if (!raw) return undefined
  if (raw.includes('@lid')) {
    const user = raw.split('@')[0].split(':')[0]
    return user ? `${user}@lid` : raw
  }
  if (raw.includes('@s.whatsapp.net')) {
    const user = raw.split('@')[0].split(':')[0]
    return user ? `${user}@s.whatsapp.net` : raw
  }
  return raw
}

export interface rejectCall {
  (_callId: string, _callFrom: string): Promise<void>
}

export interface sendCallNode {
  (_node: BinaryNode): Promise<void>
}

export interface fetchImageUrl {
  (_jid: string): Promise<string | undefined>
}

export interface fetchGroupMetadata {
  (_jid: string): Promise<GroupMetadata | undefined>
}

export interface groupMetadata {
  (_jid: string): Promise<GroupMetadata | undefined>
}

export interface exists {
  (_jid: string): Promise<string | undefined>
}

export interface groupCreate {
  (_subject: string, _participants: string[]): Promise<GroupMetadata>
}

export interface groupUpdateSubject {
  (_jid: string, _subject: string): Promise<void>
}

export interface groupUpdateDescription {
  (_jid: string, _description?: string): Promise<void>
}

export interface groupUpdatePicture {
  (_jid: string, _pictureUrl: string): Promise<void>
}

export interface groupParticipantsUpdate {
  (_jid: string, _participants: string[], _action: 'add' | 'remove' | 'promote' | 'demote'): Promise<any[]>
}

export interface groupInviteCode {
  (_jid: string): Promise<string | undefined>
}

export interface groupRequestParticipantsList {
  (_jid: string): Promise<any[]>
}

export interface groupRequestParticipantsUpdate {
  (_jid: string, _participants: string[], _action: 'approve' | 'reject'): Promise<any[]>
}

export interface groupLeave {
  (_jid: string): Promise<void>
}

export interface groupSettingUpdate {
  (_jid: string, _setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<void>
}

export interface groupJoinApprovalMode {
  (_jid: string, _mode: 'on' | 'off'): Promise<void>
}

export interface close {
  (): Promise<void>
}

export interface logout {
  (): Promise<void>
}

export type Status = {
  attempt: number
}

/**
 * Establish and manage a Baileys WASocket connection bound to a phone session.
 * Exposes a high-level API (send/read/exists/close/logout) used by ClientBaileys.
 */
export const connect = async ({
  phone,
  store,
  onQrCode,
  onNotification,
  onDisconnected,
  onReconnect,
  onNewLogin,
  attempts = Infinity,
  time,
  config = defaultConfig,
}: {
  phone: string
  store: Store
  onQrCode: OnQrCode
  onNotification: OnNotification
  onDisconnected: OnDisconnected
  onReconnect: OnReconnect
  onNewLogin: OnNewLogin
  attempts: number
  time: number
  config: Partial<Config>
}) => {
  let sock: WASocket | undefined = undefined
  const msgRetryCounterCache = (() => {
    const store = new Map<string, unknown>()
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: <T = any>(key: string): T | undefined => store.get(key) as T | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: <T = any>(key: string, value: T) => (store.set(key, value), true as const),
      del: (key: string) => store.delete(key),
      flushAll: () => store.clear(),
    }
  })()
  const whatsappVersion = config.whatsappVersion
  let resolvedWhatsappVersion = whatsappVersion
  let historyAlreadySynced = false
  let historySyncInProgress = false
  const eventsMap = new Map()
  const { dataStore, state, saveCreds, sessionStore } = store
  // Parse fallback order for addressing mode on group retries (e.g., "lid,pn" or "pn,lid").
  // Se vazio, desabilita fallback (mantém sempre o modo preferido configurado).
  const groupFallbackOrder: ('pn' | 'lid')[] = (() => {
    try {
      const raw = (GROUP_SEND_FALLBACK_ORDER || '').toString()
      if (!raw.trim()) return []
      const parts = raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === 'pn' || s === 'lid') as ('pn' | 'lid')[]
      const uniq = Array.from(new Set(parts)) as ('pn' | 'lid')[]
      if (uniq.length >= 2) return uniq.slice(0, 2)
      if (uniq.length === 1) return uniq[0] === 'lid' ? ['lid', 'pn'] : ['pn', 'lid']
      return []
    } catch { return [] }
  })()
  // Track recent group sends to enable a single fallback retry on ack 421
  const pendingGroupSends: Map<string, { to: string; message: AnyMessageContent; options: any; attempted: Set<'pn' | 'lid' | ''>; retries: number }> = new Map()
  // Throttle heavy assert operations
  const lastGroupAssert = new Map<string, number>()
  const lastReceiptAssert = new Map<string, number>()
  // Cooldown for decrypt-stub based asserts (per jid)
  const lastDecryptAssert = new Map<string, number>()
  // Cooldown por destinatário para preassert 1:1
  const lastOneToOneAssertAt = new Map<string, number>()
  // Track recent contacts seen (jid -> lastSeenMs)
  const recentContacts = new Map<string, number>()
  // Handle do timer do assert periódico
  let periodicAssertTimer: NodeJS.Timeout | undefined
  let idleReconnectTimer: NodeJS.Timeout | undefined
  let idleReconnectInProgress = false
  let lastSocketActivityAt = Date.now()
  const touchSocketActivity = () => {
    lastSocketActivityAt = Date.now()
  }
  // Track outgoing messages awaiting server ack to optionally assert sessions and resend with same id (up to 3 attempts)
  const pendingAckResend: Map<string, { to: string; message: AnyMessageContent; options: any; attemptIndex: number; timer?: NodeJS.Timeout }> = new Map()
  // Track recent 1:1 sends so PN->LID fallback on 463/479 works even when ACK_RETRY is disabled
  const pendingOneToOneErrorFallbacks: Map<string, { to: string; message: AnyMessageContent; options: any; timer?: NodeJS.Timeout }> = new Map()
  // Track 1:1 PN->LID fallback retries triggered by server ack errors such as 463/479
  const pendingOneToOneAddressingFallback = new Set<string>()
  // Track messages that got only SERVER_ACK (sent) and never delivered/read, to try session recreation
  const pendingDeliveryWatch: Map<string, { to: string; message: AnyMessageContent; options: any; attempt: number; timer?: NodeJS.Timeout }> = new Map()
  const pendingStaleDeliveryRecovery: Map<string, { to: string; message: AnyMessageContent; options: any; createdAt: number; dueAt: number; attempts: number }> = new Map()
  let staleDeliveryRecoveryTimer: NodeJS.Timeout | undefined
  // Background LID->PN resolver (per session)
  const lidResolveQueue: Map<string, { next: number; attempts: number; lastSeen: number }> = new Map()
  let lidResolverTimer: NodeJS.Timeout | undefined
  const scheduleLidResolve = (jid?: string) => {
    try {
      const v = `${jid || ''}`
      if (!v || !isLidUser(v)) return
      const now = Date.now()
      if (!lidResolveQueue.has(v)) {
        if (lidResolveQueue.size >= Math.max(100, LID_RESOLVER_MAX_PENDING || 0)) {
          try {
            let oldestKey: string | null = null
            let oldestSeen = Infinity
            for (const [k, st] of lidResolveQueue.entries()) {
              if (st.lastSeen < oldestSeen) { oldestSeen = st.lastSeen; oldestKey = k }
            }
            if (oldestKey) lidResolveQueue.delete(oldestKey)
          } catch {}
        }
        lidResolveQueue.set(v, { next: now, attempts: 0, lastSeen: now })
      } else {
        const st = lidResolveQueue.get(v)!
        st.lastSeen = now
        if (st.attempts === 0) st.next = now
      }
    } catch {}
  }
  // Fast-path: consult Baileys internal lidMapping cache (if available) to resolve LID -> PN and persist mapping
  const resolveViaSignalRepo = async (lidJid: string): Promise<string | undefined> => {
    try {
      if (!lidJid || !isLidUser(lidJid)) return undefined
      // @ts-ignore
      const repo = (sock as any)?.signalRepository?.lidMapping
      const fn = (repo && typeof repo.getPNForLID === 'function') ? repo.getPNForLID.bind(repo) : undefined
      if (!fn) return undefined
      const res = await fn(lidJid)
      const pn = `${res || ''}`
      if (pn && isPnUser(pn)) {
        try { await (dataStore as any).setJidMapping?.(phone, pn, lidJid) } catch {}
        return pn
      }
    } catch {}
    return undefined
  }
  const attemptResolveOne = async (lidJid: string) => {
    try {
      // 1) Already cached?
      try {
        const mapped = await (dataStore as any).getPnForLid?.(phone, lidJid)
        if (mapped && isPnUser(mapped)) {
          try { await (dataStore as any).setJidMapping?.(phone, mapped, lidJid) } catch {}
          return true
        }
      } catch {}
      // 1b) Baileys internal lidMapping (fast-path)
      try {
        const pn = await resolveViaSignalRepo(lidJid)
        if (pn && isPnUser(pn)) return true
      } catch {}
      // 2) Derive PN candidate via normalization and confirm with onWhatsApp when possible
      let pnCandidate: string | null = null
      try {
        const norm = jidNormalizedUser(lidJid as any)
        if (isPnUser(norm)) pnCandidate = norm as any
      } catch {}
      if (!pnCandidate) return false
      try {
        const digits = jidToPhoneNumber(pnCandidate, '')
        if (digits) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res: any = await (sock as any)?.onWhatsApp?.(digits)
          const ok = Array.isArray(res) && res[0]?.exists && res[0]?.jid
          if (ok && isPnUser(res[0].jid)) pnCandidate = res[0].jid
        }
      } catch {}
      if (pnCandidate && isPnUser(pnCandidate)) {
        try { await (dataStore as any).setJidMapping?.(phone, pnCandidate, lidJid) } catch {}
        return true
      }
    } catch {}
    return false
  }
  const sweepLidResolver = async () => {
    if (!LID_RESOLVER_ENABLED) return
    const now = Date.now()
    const delays = (Array.isArray(LID_RESOLVER_BACKOFF_MS) && LID_RESOLVER_BACKOFF_MS.length) ? LID_RESOLVER_BACKOFF_MS : [15000, 60000, 300000]
    for (const [lid, st] of Array.from(lidResolveQueue.entries())) {
      if (st.next > now) continue
      const done = await attemptResolveOne(lid)
      if (done) {
        lidResolveQueue.delete(lid)
        continue
      }
      const idx = Math.min(st.attempts, delays.length - 1)
      const delayMs = delays[idx]
      st.attempts += 1
      st.next = now + delayMs
      if (st.attempts > delays.length) st.attempts = delays.length
      lidResolveQueue.set(lid, st)
    }
    // No mesmo timer do LID resolver: enriquecer JIDMAP a partir do contact-info (leve, com limite por varredura)
    try {
      if ((config as any)?.useRedis && JIDMAP_ENRICH_ENABLED) {
      }
    } catch {}
    // Também espelhar o cache interno do Baileys (unoapi-auth:*:lid-mapping-*) para o JIDMAP
    try {
      if ((config as any)?.useRedis && JIDMAP_ENRICH_AUTH_ENABLED) {
        await enrichJidMapFromAuthLidCache(phone)
      }
    } catch {}
  }
  const ensureLidResolverTimer = () => {
    if (!LID_RESOLVER_ENABLED || lidResolverTimer) return
    const every = Math.max(2000, LID_RESOLVER_SWEEP_INTERVAL_MS || 10000)
    lidResolverTimer = setInterval(() => { sweepLidResolver().catch(() => undefined) }, every) as unknown as NodeJS.Timeout
  }
  const scheduleAckWatch = (to: string, messageId: string, message: AnyMessageContent, options: any) => {
    try { if (!(ACK_RETRY_ENABLED)) return } catch { /* ignore */ return }
    try { if (!messageId) return } catch { return }
    const delaysEnv = (ACK_RETRY_DELAYS_MS || [])
    const delays = (Array.isArray(delaysEnv) && delaysEnv.length > 0) ? delaysEnv : [8000, 30000, 60000]
    const existing = pendingAckResend.get(messageId)
    const maxAttempts = (ACK_RETRY_MAX_ATTEMPTS && ACK_RETRY_MAX_ATTEMPTS > 0) ? Math.min(ACK_RETRY_MAX_ATTEMPTS, delays.length) : delays.length
    if (existing && existing.attemptIndex >= maxAttempts) return
    const entry = existing || { to, message, options, attemptIndex: 0 }
    const scheduleNext = () => {
      if (entry.attemptIndex >= maxAttempts) return
      const delayMs = delays[entry.attemptIndex]
      if (entry.timer) { try { clearTimeout(entry.timer) } catch {} }
      try {
        const attemptNo = entry.attemptIndex + 1
        logger.info('ACK watch: scheduling attempt %s/%s for id=%s to=%s in %sms', attemptNo, maxAttempts, messageId, entry.to, delayMs)
      } catch {}
      entry.timer = setTimeout(async () => {
        try {
          if (!pendingAckResend.has(messageId)) return
          // Assert sessions for target (include PN variant and self when applicable)
          try {
            const attemptNo = entry.attemptIndex + 1
            logger.info('ACK resend: attempt %s/%s for id=%s to=%s (assert+resend same id)', attemptNo, maxAttempts, messageId, entry.to)
          } catch {}
          try {
            const assertOneToOne = async () => {
              const set = new Set<string>()
              set.add(entry.to)
              try {
                if (isLidUser(entry.to)) {
                  try { set.add(jidNormalizedUser(entry.to)) } catch {}
                } else if (isPnUser(entry.to)) {
                  try {
                    const lid = await (dataStore as any).getLidForPn?.(phone, entry.to)
                    if (lid && typeof lid === 'string') set.add(lid)
                  } catch {}
                }
                const self = state?.creds?.me?.id
                if (self) { set.add(self); try { set.add(jidNormalizedUser(self)) } catch {} }
              } catch {}
              const targets = Array.from(set)
              if (targets.length) await (sock as any).assertSessions(targets, true)
            }
            const assertGroup = async () => {
              const gm = await dataStore.loadGroupMetada(to, sock!)
              const raw: string[] = (gm?.participants || [])
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((p: any) => (p?.id || p?.jid || p?.lid || '').toString())
                .filter((v) => !!v)
              const lids: string[] = []
              const pns: string[] = []
              for (const j of raw) {
                if (!j) continue
                try {
                  if (isLidUser(j)) { lids.push(j); try { const pn = jidNormalizedUser(j); if (pn) pns.push(pn as any) } catch {} }
                  else { pns.push(j) }
                } catch {}
              }
              try { const self = state?.creds?.me?.id; if (self) { if (isLidUser(self)) lids.push(self); else pns.push(self) } } catch {}
              const unique = (arr: string[]) => Array.from(new Set(arr))
              const lidsU = unique(lids)
              const pnsU = unique(pns)
              const chunkSize = Math.max(20, GROUP_ASSERT_CHUNK_SIZE)
              const assertChunked = async (arr: string[]) => {
                for (let i = 0; i < arr.length; i += chunkSize) {
                  const chunk = arr.slice(i, i + chunkSize)
                  try { if (chunk.length) await (sock as any).assertSessions(chunk, true) } catch (ce) { logger.warn(ce as any, 'Ignore error asserting group chunk %s-%s', i, i + chunk.length) }
                }
              }
              if (lidsU.length) await assertChunked(lidsU)
              if (pnsU.length) await assertChunked(pnsU)
            }
            if (typeof entry.to === 'string' && entry.to.endsWith('@g.us')) await assertGroup()
            else await assertOneToOne()
          } catch (e) { logger.warn(e as any, 'Ignore error asserting sessions before resend') }
          // Resend with the same id (prefer LID when configured and mapping exists)
          const opts = { ...(entry.options || {}), messageId }
          let resendTo = entry.to
          try {
            if (typeof entry.to === 'string' && isIndividualJid(entry.to) && ONE_TO_ONE_ADDRESSING_MODE !== 'pn') {
              if (isPnUser(entry.to)) {
                try {
                  const lid = await (dataStore as any).getLidForPn?.(phone, entry.to)
                  if (lid && typeof lid === 'string') {
                    resendTo = lid
                    ;(opts as any).addressingMode = WAMessageAddressingMode.LID
                    try { logger.warn('LID_SEND(ACK): switching PN %s -> LID %s', entry.to, resendTo) } catch {}
                  } else {
                    ;(opts as any).addressingMode = WAMessageAddressingMode.PN
                  }
                } catch {}
              } else if (isLidUser(entry.to)) {
                ;(opts as any).addressingMode = WAMessageAddressingMode.LID
              }
            }
          } catch {}
          try { await sock?.sendMessage(resendTo, entry.message, opts) } catch (e) { logger.warn(e as any, 'Resend with same id failed') }
        } finally {
          // advance attempt counter and either schedule next or fail out
          entry.attemptIndex += 1
          if (entry.attemptIndex < maxAttempts) {
            scheduleNext()
          } else {
            // Exhausted attempts: notify own number and log
            try {
              const selfJid = phoneNumberToJid(phone)
              const text = `Falha ao entregar a mensagem ${messageId} para ${entry.to} após 3 tentativas.`
              logger.error('ACK timeout: %s', text)
              try { await sock?.sendMessage(selfJid, { text }, {}) } catch (e) { logger.warn(e as any, 'Erro ao notificar falha no próprio número') }
            } catch (e) { logger.warn(e as any, 'Erro ao preparar notificação de falha') }
            try { if (entry.timer) clearTimeout(entry.timer) } catch {}
            pendingAckResend.delete(messageId)
          }
        }
      }, delayMs) as unknown as NodeJS.Timeout
      pendingAckResend.set(messageId, entry)
    }
    scheduleNext()
  }

  const purgeSignalSessionsFor = async (toJid: string, forceDeviceList = false) => {
    if (SIGNAL_CACHE_SAFE_MODE) return
    try {
      const ids: string[] = []
      const pn = (() => { try { return jidNormalizedUser(toJid) } catch { return undefined } })()
      if (typeof toJid === 'string' && toJid) ids.push(toJid)
      if (pn && typeof pn === 'string') ids.push(pn)
      // Incluir variante mapeada (PN<->LID) quando disponível
      try {
        if (isPnUser(toJid)) {
          const lid = await (dataStore as any).getLidForPn?.(phone, toJid)
          if (lid && typeof lid === 'string') ids.push(lid)
        } else if (isLidUser(toJid)) {
          const mappedPn = await (dataStore as any).getPnForLid?.(phone, toJid)
          if (mappedPn && typeof mappedPn === 'string') ids.push(mappedPn)
        }
      } catch {}
      // BR: incluir candidatos alternativos 12<->13 para PN JIDs
      try {
        if (typeof toJid === 'string' && toJid.endsWith('@s.whatsapp.net')) {
          const digits = ensurePn(toJid)
          if (digits && digits.startsWith('55')) {
            const ddd = digits.slice(2, 4)
            if (digits.length === 12) {
              const local = digits.slice(4)
              if (/[6-9]/.test(local[0])) ids.push(`55${ddd}9${local}@s.whatsapp.net`)
            } else if (digits.length === 13) {
              const local9 = digits.slice(4)
              ids.push(`55${ddd}${local9.slice(1)}@s.whatsapp.net`)
            }
          }
        }
      } catch {}
      // Redis-backed sessions
        if ((config as any)?.useRedis) {
          if (SIGNAL_SESSION_PURGE_ENABLED) {
            try { await delSignalSessionsForJids(phone, ids, { forceDeviceList }) } catch {}
          }
        } else {
        // File-backed sessions: remove session-<addr>* files
        try {
          const dir = `${SESSION_DIR}/${phone}`
          const files = readdirSync(dir)
          for (const id of ids) {
            const prefix = `session-${id}`
            for (const f of files) {
              try { if (f.startsWith(prefix)) rmSync(`${dir}/${f}`) } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }

  const scheduleDeliveryWatch = (to: string, messageId: string, message: AnyMessageContent, options: any) => {
    try { if (!DELIVERY_WATCHDOG_ENABLED || SIGNAL_CACHE_SAFE_MODE) return } catch { return }
    try { if (!messageId) return } catch { return }
    // Skip groups unless explicitly enabled
    try { if (typeof to === 'string' && to.endsWith('@g.us') && !DELIVERY_WATCHDOG_GROUPS) return } catch {}
    const maxAttempts = Math.max(0, DELIVERY_WATCHDOG_MAX_ATTEMPTS || 0)
    const existing = pendingDeliveryWatch.get(messageId)
    const entry = existing || { to, message, options, attempt: 0 }
    const scheduleNext = () => {
      if (entry.attempt >= maxAttempts) return
      const delayMs = Math.max(5000, DELIVERY_WATCHDOG_MS || 45000)
      if (entry.timer) { try { clearTimeout(entry.timer) } catch {} }
      entry.timer = setTimeout(async () => {
        let shouldConsumeAttempt = true
        try {
          if (!pendingDeliveryWatch.has(messageId)) return
          // Avoid concurrent resend flows for the same message:
          // if ACK retry is still active, defer delivery watchdog attempt.
          if (pendingAckResend.has(messageId)) {
            shouldConsumeAttempt = false
            try { logger.debug('DELIVERY watch: deferred because ACK retry is still pending for id=%s', messageId) } catch {}
            return
          }
          try { logger.info('DELIVERY watch: firing attempt %s/%s for id=%s to=%s', entry.attempt + 1, maxAttempts, messageId, to) } catch {}
          // Force: purge current signal sessions for target and assert again
          // Purge device-list as well to force fresh device enumeration (multi-device "Aguardando" fix)
          try { await purgeSignalSessionsFor(to, true) } catch {}
          // Re-assert (cover PN/LID + self) and resend same id without userDevices cache
          try {
            const set = new Set<string>()
            set.add(to)
            try { if (isLidUser(to)) set.add(jidNormalizedUser(to)) } catch {}
            const self = state?.creds?.me?.id
            if (self) { set.add(self); try { set.add(jidNormalizedUser(self)) } catch {} }
            const targets = Array.from(set)
            if (targets.length) {
              await (sock as any).assertSessions(targets, true)
              try { logger.debug('DELIVERY watch: asserted %s targets before resend id=%s', targets.length, messageId) } catch {}
              try { if (ONE_TO_ONE_ASSERT_PROBE_ENABLED && (config as any)?.useRedis) await countSignalSessionsForJids(phone, targets) } catch {}
            }
          } catch {}
          // BR alternate addressing: try toggling 12 <-> 13 digits for PN JIDs
          let targetTo = to
          try {
            if (typeof to === 'string' && to.endsWith('@s.whatsapp.net')) {
              const digits = ensurePn(to)
              if (digits && digits.startsWith('55')) {
                const ddd = digits.slice(2, 4)
                let altDigits: string | null = null
                if (digits.length === 12) {
                  // build 13 candidate by inserting '9' after DDD when local starts with [6-9]
                  const local = digits.slice(4)
                  const cand13 = /[6-9]/.test(local[0]) ? `55${ddd}9${local}` : ''
                  if (cand13) altDigits = cand13
                } else if (digits.length === 13) {
                  // build 12 candidate by removing '9' after DDD
                  const local9 = digits.slice(4)
                  altDigits = `55${ddd}${local9.slice(1)}`
                }
                if (altDigits) {
                  try {
                    const res: any = await (sock as any)?.onWhatsApp?.(altDigits)
                    const existsOk = Array.isArray(res) && !!res[0]?.exists && !!res[0]?.jid
                    const altJid = Array.isArray(res) ? res[0]?.jid : undefined
                    try { logger.info('BR_SEND_ORDER(WD): tested %s => exists=%s jid=%s', altDigits, `${existsOk}`, altJid || '<none>') } catch {}
                    if (existsOk && altJid) {
                      // Antes de alternar, afirma sessão do candidato alternativo para forçar renovação de chaves
                      try {
                        await (sock as any).assertSessions([altJid], true)
                        try { logger.debug('BR_SEND_ORDER(WD): asserted alternate session %s', altJid) } catch {}
                      } catch (ae) { logger.warn(ae as any, 'BR_SEND_ORDER(WD): assertSessions failed for alternate %s', altJid) }
                      targetTo = altJid
                      try { logger.warn('BR_SEND_ORDER(WD): choosing alternate candidate %s', targetTo) } catch {}
                    } else {
                      try { logger.warn('BR_SEND_ORDER(WD): keep original %s (alternate not valid)', to) } catch {}
                    }
                  } catch (oe) {
                    logger.warn(oe as any, 'BR_SEND_ORDER(WD): onWhatsApp check failed for %s', altDigits)
                  }
                }
              }
            }
          } catch {}
          // Reassert final targets (original + escolhido) para garantir chaves antes do reenvio
          try {
            const finalSet = new Set<string>()
            finalSet.add(to)
            finalSet.add(targetTo)
            try { if (isLidUser(to)) finalSet.add(jidNormalizedUser(to)) } catch {}
            try { if (isLidUser(targetTo)) finalSet.add(jidNormalizedUser(targetTo)) } catch {}
            const self = state?.creds?.me?.id
            if (self) { finalSet.add(self); try { finalSet.add(jidNormalizedUser(self)) } catch {} }
            const finalTargets = Array.from(finalSet)
            if (finalTargets.length) {
              await (sock as any).assertSessions(finalTargets, true)
              try { logger.debug('DELIVERY watch: asserted final targets %s for resend id=%s', finalTargets.length, messageId) } catch {}
              try { if (ONE_TO_ONE_ASSERT_PROBE_ENABLED && (config as any)?.useRedis) await countSignalSessionsForJids(phone, finalTargets) } catch {}
            }
          } catch (fae) { logger.warn(fae as any, 'DELIVERY watch: final assert failed before resend') }
          const opts = { ...(entry.options || {}), messageId, useUserDevicesCache: false }
          try { await sock?.sendMessage(targetTo, entry.message, opts); try { logger.info('DELIVERY watch: resent id=%s to=%s (same id)', messageId, targetTo) } catch {} } catch (e) { logger.warn(e as any, 'DeliveryWatch resend failed') }
        } finally {
          if (shouldConsumeAttempt) {
            entry.attempt += 1
          }
          if (entry.attempt < maxAttempts) scheduleNext()
          else {
            try { if (entry.timer) clearTimeout(entry.timer) } catch {}
            pendingDeliveryWatch.delete(messageId)
          }
        }
      }, delayMs) as unknown as NodeJS.Timeout
      pendingDeliveryWatch.set(messageId, entry)
      try { logger.info('DELIVERY watch: scheduled attempt %s/%s for id=%s to=%s in %sms', entry.attempt + 1, maxAttempts, messageId, to, Math.max(5000, DELIVERY_WATCHDOG_MS || 45000)) } catch {}
    }
    scheduleNext()
  }

  const isDeliveredLikeStatus = (status?: string) => {
    const s = `${status || ''}`.toLowerCase()
    return s === 'delivered' || s === 'read' || s === 'deleted' || s === 'failed'
  }

  const ensureStaleDeliveryRecoveryTimer = () => {
    if (staleDeliveryRecoveryTimer || !DELIVERY_STALE_RECOVERY_ENABLED) return
    const intervalMs = Math.max(5000, DELIVERY_STALE_RECOVERY_SCAN_MS || 30000)
    staleDeliveryRecoveryTimer = setInterval(async () => {
      try {
        if (!pendingStaleDeliveryRecovery.size) return
        const now = Date.now()
        const batch = Array.from(pendingStaleDeliveryRecovery.entries())
          .filter(([, entry]) => entry.dueAt <= now)
          .slice(0, Math.max(1, DELIVERY_STALE_RECOVERY_BATCH_SIZE || 1))
        for (const [messageId, entry] of batch) {
          try {
            const currentStatus = `${await dataStore.loadStatus(messageId) || ''}`.toLowerCase()
            if (isDeliveredLikeStatus(currentStatus)) {
              pendingStaleDeliveryRecovery.delete(messageId)
              logger.info('STALE_DELIVERY recovery: clear id=%s status=%s', messageId, currentStatus)
              continue
            }
            if (currentStatus !== 'sent') {
              entry.dueAt = now + Math.max(intervalMs, DELIVERY_STALE_RECOVERY_MS || 120000)
              logger.debug('STALE_DELIVERY recovery: wait id=%s status=%s', messageId, currentStatus || '<none>')
              continue
            }
            if (entry.attempts >= Math.max(0, DELIVERY_STALE_RECOVERY_MAX_ATTEMPTS || 0)) {
              pendingStaleDeliveryRecovery.delete(messageId)
              logger.warn('STALE_DELIVERY recovery: exhausted id=%s to=%s status=%s', messageId, entry.to, currentStatus)
              continue
            }
            entry.attempts += 1
            entry.dueAt = now + Math.max(intervalMs, DELIVERY_STALE_RECOVERY_MS || 120000)
            logger.warn('STALE_DELIVERY recovery: attempt=%s id=%s to=%s status=%s', entry.attempts, messageId, entry.to, currentStatus)
            try { await purgeSignalSessionsFor(entry.to, true) } catch {}
            const targets = new Set<string>()
            targets.add(entry.to)
            try { if (isLidUser(entry.to)) targets.add(jidNormalizedUser(entry.to)) } catch {}
            try {
              const self = state?.creds?.me?.id
              if (self) {
                targets.add(self)
                try { targets.add(jidNormalizedUser(self)) } catch {}
              }
            } catch {}
            try {
              const list = Array.from(targets).filter(Boolean)
              if (list.length) await (sock as any).assertSessions(list, true)
            } catch (e) {
              logger.warn(e as any, 'STALE_DELIVERY recovery: assert failed id=%s', messageId)
            }
            try {
              await sock?.sendMessage(entry.to, entry.message, {
                ...(entry.options || {}),
                messageId,
                forceDeliveryRecovery: true,
                forceSessionRefresh: true,
                forceDeviceList: true,
                useUserDevicesCache: false,
              })
              logger.warn('STALE_DELIVERY recovery: resent id=%s to=%s', messageId, entry.to)
            } catch (e) {
              logger.warn(e as any, 'STALE_DELIVERY recovery: resend failed id=%s to=%s', messageId, entry.to)
            }
          } catch (e) {
            logger.warn(e as any, 'STALE_DELIVERY recovery: item failed id=%s', messageId)
          }
        }
      } catch (e) {
        logger.warn(e as any, 'STALE_DELIVERY recovery: interval failed')
      }
    }, intervalMs) as unknown as NodeJS.Timeout
    try { (staleDeliveryRecoveryTimer as any)?.unref?.() } catch {}
    try { logger.info('STALE_DELIVERY recovery enabled: delay=%sms scan=%sms attempts=%s batch=%s', DELIVERY_STALE_RECOVERY_MS, intervalMs, DELIVERY_STALE_RECOVERY_MAX_ATTEMPTS, DELIVERY_STALE_RECOVERY_BATCH_SIZE) } catch {}
  }

  const scheduleStaleDeliveryRecovery = (to: string, messageId: string, message: AnyMessageContent, options: any) => {
    try {
      if (!DELIVERY_STALE_RECOVERY_ENABLED || SIGNAL_CACHE_SAFE_MODE) return
      if (!messageId || !to) return
      const isGroup = typeof to === 'string' && to.endsWith('@g.us')
      if (isGroup && !DELIVERY_STALE_RECOVERY_GROUPS) return
      if (!isGroup && !isIndividualJid(to)) return
      const maxPending = Math.max(100, DELIVERY_STALE_RECOVERY_MAX_PENDING || 0)
      if (!pendingStaleDeliveryRecovery.has(messageId) && pendingStaleDeliveryRecovery.size >= maxPending) {
        let oldestKey = ''
        let oldestAt = Infinity
        for (const [key, entry] of pendingStaleDeliveryRecovery.entries()) {
          if (entry.createdAt < oldestAt) {
            oldestAt = entry.createdAt
            oldestKey = key
          }
        }
        if (oldestKey) pendingStaleDeliveryRecovery.delete(oldestKey)
      }
      const now = Date.now()
      const delayMs = Math.max(30000, DELIVERY_STALE_RECOVERY_MS || 120000)
      pendingStaleDeliveryRecovery.set(messageId, {
        to,
        message,
        options: { ...(options || {}) },
        createdAt: now,
        dueAt: now + delayMs,
        attempts: 0,
      })
      ensureStaleDeliveryRecoveryTimer()
    } catch {}
  }

  const clearStaleDeliveryRecovery = (messageId: string, status?: string) => {
    try {
      if (!messageId) return
      if (pendingStaleDeliveryRecovery.delete(messageId)) {
        logger.info('STALE_DELIVERY recovery: clear id=%s status=%s', messageId, status || '<none>')
      }
    } catch {}
  }
  const firstSaveCreds = async () => {
    if (state?.creds?.me?.id) {
      // Normalize possible LID JID to PN JID before extracting phone
      let meId = state?.creds?.me?.id as string
      try {
        if (isLidUser(meId)) {
          meId = jidNormalizedUser(meId)
        }
      } catch {}
      const phoneCreds = jidToPhoneNumber(meId, '')
      logger.info(`First save creds with number is ${phoneCreds} and configured number ${phone}`)
      if (VALIDATE_SESSION_NUMBER && phoneCreds != phone) {
        await logout()
        const message =  t('session_conflict', phoneCreds, phone)
        logger.error(message)
        await onNotification(message, true)
        currentSaveCreds = async () => logger.error(message)
      } else {
        logger.info(`Correct save creds with number is ${phoneCreds} and configured number ${phone}`)
        // Persistir imediatamente o primeiro snapshot de credenciais
        try {
          await saveCreds()
        } catch (e) {
          logger.warn(e as any, 'Failed to persist initial creds; will retry on next creds.update')
        }
        currentSaveCreds = saveCreds
      }
    }
  }
  let currentSaveCreds = firstSaveCreds
  const verifyAndSaveCreds = async () => currentSaveCreds()
  let connectingTimeout

  const status: Status = {
    attempt: time,
  }
  let suppressQrUntil = 0

  const onConnectionUpdate = async (event: Partial<ConnectionState>) => {
    touchSocketActivity()
    logger.debug('onConnectionUpdate connectionType %s ==> %s %s', config.connectionType, phone, JSON.stringify(event))
    // Evita emitir QR code quando a sessão já está efetivamente online/aberta
    if (event.qr && config.connectionType == 'qrcode') {
      if (suppressQrUntil > Date.now()) {
        logger.info('Skip QR emission during post-login grace window for %s (remaining=%sms)', phone, suppressQrUntil - Date.now())
        return
      }
      const registered = !!sock?.authState?.creds?.registered || !!state?.creds?.me?.id
      const alreadyOnline = await sessionStore.isStatusOnline(phone)
      const isOpen = event.connection === 'open' || event.isOnline === true
      if (!registered && !alreadyOnline && !isOpen) {
        if (status.attempt > attempts) {
          const message =  t('attempts_exceeded', attempts)
          logger.debug(message)
          await onNotification(message, true)
          status.attempt = 1
          const registered = !!sock?.authState?.creds?.registered || !!state?.creds?.me?.id
          const isOpen = event.connection === 'open' || event.isOnline === true
          const alreadyOnline = await sessionStore.isStatusOnline(phone)
          if (registered || isOpen || alreadyOnline) {
            logger.info('Skip attempts_exceeded cleanup; session already open %s', phone)
            return
          }
          await sessionStore.setStatus(phone, 'offline')
          return
        } else {
          logger.debug('QRCode generate... %s of %s', status.attempt, attempts)
          return onQrCode(event.qr, status.attempt++, attempts)
        }
      } else {
        logger.debug('Skip QR emission (registered=%s online=%s open=%s)', registered, alreadyOnline, isOpen)
      }
    }

    if (event.isNewLogin) {
      suppressQrUntil = Date.now() + Math.max(0, QR_POST_LOGIN_SUPPRESS_MS)
      logger.info('New login detected for %s, suppressing QR re-emit for %sms', phone, Math.max(0, QR_POST_LOGIN_SUPPRESS_MS))
      await onNewLogin(phone)
    }

    if (event.receivedPendingNotifications) {
      await onNotification(t('received_pending_notifications'), true)
    }

    if (event.isOnline) {
      await onNotification(t('online_session'), true)
    }
    
    switch (event.connection) {
      case 'open':
        await onOpen()
        break
        
        case 'close':
        try {
          const statusCode = (event as any)?.lastDisconnect?.error?.output?.statusCode
          logger.warn('connection.update close for %s (status=%s)', phone, statusCode)
        } catch {}
        await onClose(event)
        break

      case 'connecting':
        await onConnecting()
        break
    }
  }

  const verifyConnectingTimeout = async () => {
    if (connectingTimeout) {
      return
    }
    logger.info(`Connecting ${phone} set timeout to ${CONNECTING_TIMEOUT_MS} ms`)
    if (await sessionStore.isStatusConnecting(phone)) {
      connectingTimeout = setTimeout(async () => {
        if (await sessionStore.isStatusConnecting(phone)) {
          connectingTimeout = null
          const message = t('connection_timed_out', phone, CONNECTING_TIMEOUT_MS)
          await onNotification(message, false)
          logger.warn(message)
          await onDisconnected(phone, {})
        }
        await sessionStore.syncConnection(phone)
      }, CONNECTING_TIMEOUT_MS)
    } else {
      connectingTimeout = null
    }
  }

  const onConnecting = async () => {
    await sessionStore.setStatus(phone, 'connecting')
    const message = t('connecting')
    await onNotification(message, false)
    logger.info(message)
    return verifyConnectingTimeout()
  }

  const onOpen = async () => {
    touchSocketActivity()
    status.attempt = 1
    await sessionStore.setStatus(phone, 'online')
    if (historySyncInProgress) {
      await setHistorySyncMarker(phone, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      })
    }
    logger.info(`${phone} connected`)
    const message = t(
      'connected',
      phone,
      resolvedWhatsappVersion ? resolvedWhatsappVersion.join('.') : 'auto',
      resolvedWhatsappVersion ? resolvedWhatsappVersion.join('.') : 'auto',
      new Date().toUTCString(),
    )
    await onNotification(message, false)
    // (Re)iniciar timer do assert periódico ao ficar online
    try {
      if (PERIODIC_ASSERT_ENABLED && PERIODIC_ASSERT_INTERVAL_MS > 0 && !periodicAssertTimer) {
        periodicAssertTimer = setInterval(async () => {
          try {
            const now = Date.now()
            const entries = Array.from(recentContacts.entries())
              .filter(([_, ts]) => (now - (ts || 0)) <= PERIODIC_ASSERT_RECENT_WINDOW_MS)
              .sort((a, b) => (b[1] - a[1]))
              .slice(0, Math.max(10, PERIODIC_ASSERT_MAX_TARGETS))
            if (!entries.length) return
            const set = new Set<string>()
            for (const [jid] of entries) {
              if (typeof jid === 'string' && !!jid) {
                set.add(jid)
                try { if (isLidUser(jid)) set.add(jidNormalizedUser(jid)) } catch {}
              }
            }
            const rawTargets = Array.from(set).filter((j) => typeof j === 'string' && j.includes('@'))
            const me = (() => { try { return jidNormalizedUser(state?.creds?.me?.id || '') } catch { return '' } })()
            const targets = rawTargets.filter((j) => {
              try {
                if (!j || typeof j !== 'string') return false
                if (j === 'status@broadcast') return false
                if (!PERIODIC_ASSERT_INCLUDE_GROUPS && j.endsWith('@g.us')) return false
                const jn = (() => { try { return jidNormalizedUser(j) } catch { return j } })()
                if (me && (jn === me)) return false
                return true
              } catch { return true }
            })
            if (targets.length) {
              const fn = (sock as any)?.assertSessions
              if (typeof fn !== 'function') return
              logger.debug('PERIODIC_ASSERT: asserting %s recent targets', targets.length)
              await fn.call(sock, targets, PERIODIC_ASSERT_FORCE)
            }
          } catch (e) {
            logger.debug('Ignore periodic assert (interval): %s', (e as any)?.message || e)
          }
        }, PERIODIC_ASSERT_INTERVAL_MS) as unknown as NodeJS.Timeout
      }
    } catch {}
    try {
      if (BAILEYS_IDLE_RECONNECT_ENABLED && BAILEYS_IDLE_RECONNECT_MS > 0 && BAILEYS_IDLE_RECONNECT_CHECK_MS > 0 && !idleReconnectTimer) {
        idleReconnectTimer = setInterval(async () => {
          try {
            if (idleReconnectInProgress) return
            if (!sock) return
            if (!await sessionStore.isStatusOnline(phone)) return
            const idleMs = Date.now() - lastSocketActivityAt
            if (idleMs < BAILEYS_IDLE_RECONNECT_MS) return
            idleReconnectInProgress = true
            touchSocketActivity()
            logger.warn('%s idle watchdog: no socket activity for %sms (threshold=%sms), forcing reconnect', phone, idleMs, BAILEYS_IDLE_RECONNECT_MS)
            await close()
            try {
              await onReconnect(1)
            } catch (e) {
              logger.error(e as any, 'Idle watchdog reconnect failed for %s; fallback reconnect()', phone)
              await reconnect()
            }
          } catch (e) {
            logger.warn(e as any, 'Ignore idle watchdog error for %s', phone)
          } finally {
            idleReconnectInProgress = false
          }
        }, BAILEYS_IDLE_RECONNECT_CHECK_MS) as unknown as NodeJS.Timeout
      }
    } catch {}
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onClose = async (payload: any) => {
    // Limpar timer do assert periódico ao desconectar
    try { if (periodicAssertTimer) { clearInterval(periodicAssertTimer); periodicAssertTimer = undefined; logger.debug('PERIODIC_ASSERT: timer cleared on close') } } catch {}
    try { if (idleReconnectTimer) { clearInterval(idleReconnectTimer); idleReconnectTimer = undefined; logger.debug('IDLE_WATCHDOG: timer cleared on close') } } catch {}
    const { lastDisconnect } = payload || {}
    const statusCode = lastDisconnect?.error?.output?.statusCode
    if (await sessionStore.isStatusOffline(phone)) {
      logger.warn('Already Offline %s', phone)
      sock = undefined
      return
    }
    // Durante o pareamento é comum receber 515 logo após persistências/reloads.
    // Não bloquear esse caso com "Already Disconnected", pois precisa reconectar.
    if (await sessionStore.isStatusDisconnect(phone) && statusCode !== DisconnectReason.restartRequired) {
      logger.warn('Already Disconnected %s', phone)
      sock = undefined
      return
    }
    logger.info(`${phone} disconnected with status: ${statusCode}`)
    if ([DisconnectReason.loggedOut, 403].includes(statusCode)) {
      status.attempt = 1
      if (!await sessionStore.isStatusConnecting(phone)) {
        const message = t('removed')
        await onNotification(message, true)
      }
      await logout()
      return onDisconnected(phone, payload)
    } else if (statusCode === DisconnectReason.connectionReplaced) {
      await close()
      const message = t('unique')
      return onNotification(message, true)
    } else if (statusCode === DisconnectReason.restartRequired) {
      suppressQrUntil = Date.now() + Math.max(0, QR_POST_LOGIN_SUPPRESS_MS)
      const message = t('restart')
      await onNotification(message, true)
      await sessionStore.setStatus(phone, 'restart_required')
      logger.warn('%s received restartRequired (515), closing socket and triggering reconnect', phone)
      await close()
      try {
        return await onReconnect(1)
      } catch (e) {
        logger.error(e as any, 'onReconnect failed after restartRequired for %s; fallback reconnect()', phone)
        return reconnect(statusCode)
      }
    } else if (statusCode === DisconnectReason.badSession && config.proxyUrl && lastDisconnect?.error?.data?.options?.command?.connect) {
      const message = t('server_error', config.proxyUrl)
      await onNotification(message, true)
    } else if (status.attempt == 1) {
      const detail = lastDisconnect?.error?.output?.payload?.error
      const message = t('closed', statusCode, detail)
      await onNotification(message, true)
    }
    return reconnect(statusCode)
  }

  const getMessage = async (key: proto.IMessageKey): Promise<proto.IMessage | undefined> => {
    // Consider new Alt addressing fields introduced with LIDs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const k: any = key as any
    let remoteJid = key.remoteJid || k.remoteJidAlt
    const id = key.id
    let participant = key.participant || k.participantAlt
    // For status@broadcast receipts, avoid attempting resend via getMessage
    let jid = remoteJid
    if (!jid && participant) {
      logger.debug('Retry without remoteJid; using participant %s for id %s', participant, id)
      jid = participant
    }
    if (!jid || jid === 'status@broadcast') {
      logger.debug('Skip getMessage for jid %s id %s (status broadcast or unknown)', jid || '<empty>', id)
      return undefined
    }
    logger.debug('load message for jid %s id %s', jid, id)
    const message = await dataStore.loadMessage(jid, id!)
    return message?.message || undefined
  }

  // const patchMessageBeforeSending = (msg: proto.IMessage) => {
  //   const isProductList = (listMessage: proto.Message.IListMessage | null | undefined) =>
  //     listMessage?.listType === proto.Message.ListMessage.ListType.PRODUCT_LIST

  //   if (isProductList(msg.deviceSentMessage?.message?.listMessage) || isProductList(msg.listMessage)) {
  //     msg = JSON.parse(JSON.stringify(msg))
  //     if (msg.deviceSentMessage?.message?.listMessage) {
  //       msg.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT
  //     }
  //     if (msg.listMessage) {
  //       msg.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT
  //     }
  //   }
  //   return msg
  // }

  const event = <T extends keyof BaileysEventMap>(event: T, callback: (arg: BaileysEventMap[T]) => void) => {
    logger.info('Subscribe %s event: %s', phone, event)
    if (event === 'messages.upsert') {
      // Self-heal decrypt stub: when inbound messages arrive without decryptable content, assert sessions for participants
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = async (upsert: any) => {
        try {
          const msgs: any[] = (upsert && upsert.messages) || []
          const now = Date.now()
          const targets = new Set<string>()
          for (const m of msgs) {
            try {
              // Track recent contacts
              const remote = m?.key?.remoteJid
              const participant = m?.key?.participant
              if (typeof remote === 'string' && !!remote) {
                recentContacts.set(remote, now)
                try { if (isLidUser(remote)) recentContacts.set(jidNormalizedUser(remote), now) } catch {}
                try {
                  if (isLidUser(remote)) {
                    scheduleLidResolve(remote)
                    // Opportunistic fast resolve without blocking the event flow
                    resolveViaSignalRepo(remote).catch(() => undefined)
                  }
                } catch {}
              }
              if (typeof participant === 'string' && !!participant) {
                recentContacts.set(participant, now)
                try { if (isLidUser(participant)) recentContacts.set(jidNormalizedUser(participant), now) } catch {}
                try {
                  if (isLidUser(participant)) {
                    scheduleLidResolve(participant)
                    resolveViaSignalRepo(participant).catch(() => undefined)
                  }
                } catch {}
              }
              // Heurística de decrypt stub: mensagem vazia ou apenas senderKeyDistributionMessage (não-fromMe)
              const fromMe = !!m?.key?.fromMe
              const content = m?.message || {}
              const keys = Object.keys(content || {})
              const onlySenderKey = (keys.length === 1 && !!content.senderKeyDistributionMessage)
              const noContent = !content || keys.length === 0
              if (!fromMe && (onlySenderKey || noContent)) {
                const jid = participant || remote
                if (typeof jid === 'string' && jid) {
                  const last = lastDecryptAssert.get(jid) || 0
                  // cooldown 15s por jid
                  if (now - last > 15000) {
                    lastDecryptAssert.set(jid, now)
                    try {
                      const set = new Set<string>()
                      set.add(jid)
                      try { if (isLidUser(jid)) set.add(jidNormalizedUser(jid)) } catch {}
                      logger.info('SELFHEAL decrypt-stub: asserting sessions for %s (msg id=%s)', jid, m?.key?.id)
                      await (sock as any).assertSessions(Array.from(set), true)
                    } catch (e) {
                      logger.warn(e as any, 'Ignore error asserting sessions on decrypt-stub for %s', jid)
                    }
                  }
                }
              }
            } catch {}
          }
        } catch (e) {
          logger.warn(e as any, 'Ignore error on messages.upsert self-heal wrapper')
        }
        return (callback as any)(upsert)
      }
      // Condicional por env
      if (SELFHEAL_ASSERT_ON_DECRYPT) {
        // @ts-ignore
        eventsMap.set(event, wrapped)
      } else {
        eventsMap.set(event as any, callback as any)
      }
      return
    }
    if (event === 'messages.update') {
      // Wrap to detect ack 421 and perform a single fallback retry toggling addressingMode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = async (updates: any[]) => {
        try {
          // Log resumido de statuses recebidos (read/delivered/etc.)
          try {
            const counts: Record<string, number> = {}
            const samples: string[] = []
            if (Array.isArray(updates)) {
              for (const u of updates) {
                const s = `${u?.update?.status ?? u?.status ?? ''}`
                counts[s] = (counts[s] || 0) + 1
                const kid = u?.key?.id || u?.id
                if (kid && samples.length < 5) samples.push(kid)
              }
              const flat = Object.keys(counts).map(k => `${k}:${counts[k]}`).join(', ')
              logger.info('BAILEYS messages.update: statuses=%s samples=%s', flat || '<none>', samples.join('|') || '<none>')
            }
          } catch {}
          if (Array.isArray(updates)) {
            for (const u of updates) {
              // Clear pending ack tracking once any status is observed for the message id
              try {
                const kid = u?.key?.id || u?.id
                const st = u?.update?.status ?? u?.status
                const stubParams = Array.isArray(u?.update?.messageStubParameters) ? u.update.messageStubParameters : []
                const preserveAckRetry = stubParams.includes('463') || stubParams.includes('479')
                if (kid && (st !== undefined && st !== null)) {
                  const tracked = pendingAckResend.get(kid)
                  if (tracked && !preserveAckRetry) {
                    try { logger.info('ACK watch: clearing on status=%s id=%s', `${st}`, kid) } catch {}
                    try { if (tracked.timer) clearTimeout(tracked.timer) } catch {}
                    pendingAckResend.delete(kid)
                  }
                  const fallbackTracked = pendingOneToOneErrorFallbacks.get(kid)
                  if (fallbackTracked && !preserveAckRetry) {
                    try { if (fallbackTracked.timer) clearTimeout(fallbackTracked.timer) } catch {}
                    pendingOneToOneErrorFallbacks.delete(kid)
                  }
                  // Clear delivery watchdog only on delivered/read
                  const delivered = (() => {
                    if (typeof st === 'number') return st >= 3 // 3: DELIVERY_ACK, 4/5: READ/PLAYED
                    const s = `${st}`.toUpperCase()
                    return s === 'DELIVERY_ACK' || s === 'READ' || s === 'PLAYED'
                  })()
                  if (delivered) {
                    const dw = pendingDeliveryWatch.get(kid)
                    if (dw) {
                      try { logger.info('DELIVERY watch: clearing on status=%s id=%s', `${st}`, kid) } catch {}
                      try { if (dw.timer) clearTimeout(dw.timer) } catch {}
                      pendingDeliveryWatch.delete(kid)
                    }
                    clearStaleDeliveryRecovery(kid, `${st}`)
                  }
                }
              } catch {}
              // Also observe potential LIDs in update keys to schedule resolver
              try {
                const r = u?.key?.remoteJid
                const p = u?.key?.participant
                if (typeof r === 'string' && isLidUser(r)) scheduleLidResolve(r)
                if (typeof p === 'string' && isLidUser(p)) scheduleLidResolve(p)
              } catch {}
              const params = u?.update?.messageStubParameters
              const key = u?.key
              if (
                Array.isArray(params) &&
                params.includes('421') &&
                key?.fromMe &&
                typeof key?.remoteJid === 'string' &&
                key.remoteJid.endsWith('@g.us') &&
                groupFallbackOrder.length >= 2
              ) {
                const pending = pendingGroupSends.get(key.id)
                if (pending && pending.retries < 1) {
                  const next: 'pn' | 'lid' = (groupFallbackOrder.find((m) => !pending.attempted.has(m)) || (groupFallbackOrder[0] === 'lid' ? 'pn' : 'lid'))
                  const opts = { ...(pending.options || {}) }
                  opts.addressingMode = next === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN
                  logger.warn('Retrying group %s message %s with addressingMode %s', pending.to, key.id, next)
                  try {
                    const resp = await sock?.sendMessage(pending.to, pending.message, opts)
                    pendingGroupSends.delete(key.id)
                    if (resp?.key?.id) {
                      pending.retries = 1
                      pending.attempted.add(next)
                      pending.options = opts
                      pendingGroupSends.set(resp.key.id, pending)
                    }
                  } catch (e) {
                    logger.warn(e as any, 'Fallback resend failed')
                  }
                }
              }
              if (
                Array.isArray(params) &&
                key?.fromMe &&
                key?.id &&
                typeof key?.remoteJid === 'string' &&
                isIndividualJid(key.remoteJid) &&
                isPnUser(key.remoteJid) &&
                (params.includes('463') || params.includes('479'))
              ) {
                const pending = pendingAckResend.get(key.id)
                const fallbackPending = pending || pendingOneToOneErrorFallbacks.get(key.id)
                if (fallbackPending && !pendingOneToOneAddressingFallback.has(key.id)) {
                  let lid: string | undefined
                  try { lid = await (dataStore as any).getLidForPn?.(phone, key.remoteJid) } catch {}
                  if (lid && typeof lid === 'string' && isLidUser(lid as any)) {
                    pendingOneToOneAddressingFallback.add(key.id)
                    setTimeout(() => pendingOneToOneAddressingFallback.delete(key.id), 60_000)
                    fallbackPending.to = lid
                    fallbackPending.options = {
                      ...(fallbackPending.options || {}),
                      addressingMode: WAMessageAddressingMode.LID,
                      useUserDevicesCache: false,
                    }
                    try {
                      const assertTargets = new Set<string>()
                      assertTargets.add(lid)
                      assertTargets.add(key.remoteJid)
                      const self = state?.creds?.me?.id
                      if (self) {
                        assertTargets.add(self)
                        try { assertTargets.add(jidNormalizedUser(self)) } catch {}
                      }
                      await (sock as any).assertSessions(Array.from(assertTargets), true)
                    } catch (e) {
                      logger.warn(e as any, 'Ignore error asserting sessions before PN->LID fallback resend')
                    }
                    try {
                      logger.warn(
                        '1:1 fallback resend after ack error=%s for msg=%s: PN %s -> LID %s',
                        params.join(','),
                        key.id,
                        key.remoteJid,
                        lid,
                      )
                    } catch {}
                    try {
                      await sock?.sendMessage(lid, fallbackPending.message, {
                        ...(fallbackPending.options || {}),
                        messageId: key.id,
                        addressingMode: WAMessageAddressingMode.LID,
                        useUserDevicesCache: false,
                      })
                    } catch (e) {
                      logger.warn(e as any, '1:1 PN->LID fallback resend failed')
                    }
                  } else {
                    try {
                      logger.warn(
                        '1:1 ack error=%s for msg=%s on PN %s, but no mapped LID was found for fallback',
                        params.join(','),
                        key.id,
                        key.remoteJid,
                      )
                    } catch {}
                  }
                }
              }
            }
          }
        } catch (e) {
          logger.warn(e as any, 'Ignore error on messages.update fallback wrapper')
        }
        return (callback as any)(updates)
      }
      eventsMap.set(event as any, wrapped as any)
    } else if (event === 'message-receipt.update') {
      // Proactively assert sessions when we receive retry receipts to reduce Bad MAC during decrypt
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = async (updates: any[]) => {
        try {
          // Log resumido dos tipos recebidos (read/delivery/played/retry)
          try {
            const counts: Record<string, number> = {}
            const samples: string[] = []
            if (Array.isArray(updates)) {
              for (const u of updates) {
                const t = `${u?.receipt?.type || u?.type || u?.update?.type || ''}`
                counts[t] = (counts[t] || 0) + 1
                const kid = u?.key?.id || u?.id
                if (kid && samples.length < 5) samples.push(kid)
              }
              const flat = Object.keys(counts).map(k => `${k}:${counts[k]}`).join(', ')
              logger.info('BAILEYS message-receipt.update: types=%s samples=%s', flat || '<none>', samples.join('|') || '<none>')
            }
          } catch {}
          const targets = new Set<string>()
          let groupKey: string | null = null
          let isStatus = false
          if (Array.isArray(updates)) {
            for (const u of updates) {
              const type = u?.receipt?.type || u?.type || u?.update?.type
              const remoteJid: string | undefined = u?.key?.remoteJid || u?.remoteJid || u?.attrs?.from
              const participant: string | undefined = u?.key?.participant || u?.participant || u?.attrs?.participant
              if (type === 'retry') {
                if (remoteJid === 'status@broadcast') {
                  isStatus = true
                }
                if (remoteJid && remoteJid.endsWith('@g.us') && participant) {
                  targets.add(participant)
                  groupKey = remoteJid
                } else if (remoteJid) {
                  targets.add(remoteJid)
                }
              }
              // Observe LIDs to schedule resolver attempts
              try { if (typeof remoteJid === 'string' && isLidUser(remoteJid)) scheduleLidResolve(remoteJid) } catch {}
              try { if (typeof participant === 'string' && isLidUser(participant)) scheduleLidResolve(participant) } catch {}
            }
          }
          if (isStatus) {
            logger.debug('Skip receipt-based assert for status@broadcast')
            return (callback as any)(updates)
          }
          // Throttle receipt-based asserts per group
          const now = Date.now()
          if (groupKey) {
            const last = lastReceiptAssert.get(groupKey) || 0
            if (now - last < RECEIPT_RETRY_ASSERT_COOLDOWN_MS) {
              logger.debug('Skip receipt assert: cooldown active for %s', groupKey)
              return (callback as any)(updates)
            }
            lastReceiptAssert.set(groupKey, now)
          }
          if (targets.size) {
            const list = Array.from(targets).slice(0, RECEIPT_RETRY_ASSERT_MAX_TARGETS)
            if (list.length > 0) {
              try {
                await (sock as any).assertSessions(list, true)
                logger.debug('Asserted %s sessions on retry receipt', list.length)
              } catch (e) {
                logger.warn(e as any, 'Ignore error asserting sessions on retry receipt')
              }
            }
          }
        } catch (e) {
          logger.warn(e as any, 'Ignore error on message-receipt.update wrapper')
        }
        return (callback as any)(updates)
      }
      // @ts-ignore
      eventsMap.set(event, wrapped)
  } else if (event === 'lid-mapping.update') {
      // Cache PN <-> LID mapping updates para ajudar asserts e normalização
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = async (updates: any) => {
        try {
          const arr: any[] = Array.isArray(updates) ? updates : [updates]
          for (const u of arr) {
            try {
              // Detectar pares PN/LID de forma robusta sem regex frágil
              const collectJids = (obj: any): string[] => {
                const out: string[] = []
                const walk = (x: any) => {
                  if (!x) return
                  if (typeof x === 'string') {
                    if (x.includes('@')) out.push(x)
                    return
                  }
                  if (Array.isArray(x)) {
                    for (const it of x) walk(it)
                    return
                  }
                  if (typeof x === 'object') {
                    for (const k of Object.keys(x)) walk((x as any)[k])
                  }
                }
                walk(obj)
                return out
              }
              const all = collectJids(u).map((j) => {
                try { return normalizeTransportJid(j) } catch { return j }
              })
              let pn: string | undefined
              let lid: string | undefined
              for (const j of all) {
                try {
                  if (!pn && isPnUser(j as any)) pn = j
                  if (!lid && isLidUser(j as any)) lid = j
                } catch {}
              }
              if (pn && lid) {
                try { await (dataStore as any).setJidMapping?.(phone, pn, lid) } catch {}
                logger.debug('Updated PN<->LID mapping: %s <=> %s', pn, lid)
              }
            } catch (ie) {
              logger.warn(ie as any, 'Ignore error parsing lid-mapping.update item')
            }
          }
        } catch (e) {
          logger.warn(e as any, 'Ignore error on lid-mapping.update handler')
        }
        return (callback as any)(updates)
      }
      // @ts-ignore
      eventsMap.set(event, wrapped)
    } else {
      eventsMap.set(event, callback)
    }
  }

  // Periodic assert of recent contacts (optional)
  try {
    if (PERIODIC_ASSERT_ENABLED && PERIODIC_ASSERT_INTERVAL_MS > 0) {
      try { logger.info('PERIODIC_ASSERT enabled: interval=%sms maxTargets=%s window=%sms', PERIODIC_ASSERT_INTERVAL_MS, PERIODIC_ASSERT_MAX_TARGETS, PERIODIC_ASSERT_RECENT_WINDOW_MS) } catch {}
      if (!periodicAssertTimer) periodicAssertTimer = setInterval(async () => {
        try {
          const now = Date.now()
          const entries = Array.from(recentContacts.entries())
            .filter(([_, ts]) => (now - (ts || 0)) <= PERIODIC_ASSERT_RECENT_WINDOW_MS)
            .sort((a, b) => (b[1] - a[1]))
            .slice(0, Math.max(10, PERIODIC_ASSERT_MAX_TARGETS))
          if (!entries.length) return
          const set = new Set<string>()
          for (const [jid] of entries) {
            if (typeof jid === 'string' && !!jid) {
              set.add(jid)
              try { if (isLidUser(jid)) set.add(jidNormalizedUser(jid)) } catch {}
            }
          }
          // Filtra JIDs inválidos (vazios ou sem sufixo de domínio)
          // Monta alvos válidos e filtra self/status/grupos quando desabilitado
          const rawTargets = Array.from(set).filter((j) => typeof j === 'string' && j.includes('@'))
          const me = (() => { try { return jidNormalizedUser(state?.creds?.me?.id || '') } catch { return '' } })()
          const targets = rawTargets.filter((j) => {
            try {
              if (!j || typeof j !== 'string') return false
              if (j === 'status@broadcast') return false
              if (!PERIODIC_ASSERT_INCLUDE_GROUPS && j.endsWith('@g.us')) return false
              const jn = (() => { try { return jidNormalizedUser(j) } catch { return j } })()
              if (me && (jn === me)) return false
              return true
            } catch { return true }
          })
          if (targets.length) {
            // Evita erro quando o socket está offline/indefinido entre desconexões
            try {
              if (!sock) return
              try { if (!(await sessionStore.isStatusOnline(phone))) return } catch {}
              const fn = (sock as any)?.assertSessions
              if (typeof fn !== 'function') return
              logger.debug('PERIODIC_ASSERT: asserting %s recent targets', targets.length)
              await fn.call(sock, targets, PERIODIC_ASSERT_FORCE)
            } catch (e) {
              logger.debug('Ignore periodic assert (socket offline): %s', (e as any)?.message || e)
            }
          }
        } catch (e) {
          logger.warn(e as any, 'Ignore error in periodic assert interval')
        }
      }, PERIODIC_ASSERT_INTERVAL_MS) as unknown as NodeJS.Timeout
    }
  } catch {}

  const reconnect = async (lastStatusCode?: number) => {
    if (config.useRedis) {
      try {
        const key = configKey(phone)
        const sessionConfig = await redisGet(key)
        if (!sessionConfig) {
          logger.warn('%s reconnect skipped: redis session config not found (%s)', phone, key)
          status.attempt = 1
          await close()
          await sessionStore.setStatus(phone, 'disconnected')
          return
        }
      } catch (error) {
        logger.warn(error as any, '%s reconnect skipped: failed to verify redis session config', phone)
        status.attempt = 1
        await close()
        await sessionStore.setStatus(phone, 'disconnected')
        return
      }
    }

    logger.info(`${phone} reconnecting`, status.attempt)
    if (status.attempt > attempts) {
      const message =  t('attempts_exceeded', attempts)
      await onNotification(message, true)
      status.attempt = 1
      return close()
    } else {
      // Stream 503 bursts happen in waves; backoff avoids reconnect storms.
      if (lastStatusCode === 503) {
        const attemptIndex = Math.max(0, (status.attempt || 1) - 1)
        const base = Math.max(800, config.retryRequestDelayMs || 1000)
        const exp = Math.min(6, attemptIndex)
        const backoff = Math.min(60000, base * Math.pow(2, exp))
        const jitter = Math.floor(Math.random() * 700)
        const waitMs = backoff + jitter
        logger.warn('%s reconnect backoff for 503: waiting %sms (attempt=%s)', phone, waitMs, status.attempt)
        try { await delay(waitMs) } catch {}
      }
      const message =  t('connecting_attemps', status.attempt, attempts)
      await onNotification(message, false)
      await close()
      return onReconnect(status.attempt++)
    }
  }

  const close = async () => {
    logger.info(`${phone} close`)
    try { if (lidResolverTimer) { clearInterval(lidResolverTimer); lidResolverTimer = undefined } } catch {}
    try { if (idleReconnectTimer) { clearInterval(idleReconnectTimer); idleReconnectTimer = undefined } } catch {}
    try { if (staleDeliveryRecoveryTimer) { clearInterval(staleDeliveryRecoveryTimer); staleDeliveryRecoveryTimer = undefined } } catch {}
    try { pendingStaleDeliveryRecovery.clear() } catch {}
    EVENTS.forEach((e: any) => {
      try {
        sock?.ev?.removeAllListeners(e)
      } catch (error) {
        logger.error(`Error on removeAllListeners from ${e}`, error)
      }
    })
    const webSocket = sock?.ws['socket'] || {}
    // WebSocket.CONNECTING (0)
    // WebSocket.OPEN (1)
    // WebSocket.CLOSING (2)
    // WebSocket.CLOSED (3)
    if (`${webSocket['readyState']}` == '1'){
      if (await sessionStore.isStatusConnecting(phone) || await sessionStore.isStatusOnline(phone)) {
        try {
          await sock?.end(undefined)
        } catch (e) {
          logger.error(`Error sock end`, e)
        }
        try {
          await sock?.ws?.close()
        } catch (e) {
          logger.error(`Error on sock ws close`, e)
        }
      }
    }
    sock = undefined
    if (!await sessionStore.isStatusRestartRequired(phone)) {
      await sessionStore.setStatus(phone, 'offline')
    }
  }

  const logout = async () => {
    logger.info(`${phone} logout`)
    try {
      return sock && await sock.logout()
    } catch (error) {
      logger.error(`Error on remove session ${phone}: ${error.message}`,)  
      // ignore de unique error if already diconected session
    } finally {
      logger.info(`${phone} destroyed`)
      await dataStore.cleanSession(CLEAN_CONFIG_ON_DISCONNECT)
    }
    await close()
    await sessionStore.setStatus(phone, 'disconnected')
  }

  /**
   * Resolve a phone/JID to a concrete JID known by WhatsApp, caching via DataStore.
   * Accepts raw numbers (string) or JIDs and returns undefined when the number has no WhatsApp.
   */
  const exists: exists = async (localPhone: string) => {
    try {
      await validateStatus()
    } catch (error) {
      if (localPhone == phone) {
        logger.info(`${localPhone} is the phone connection ${phone}`)
      } else {
        throw error
      }
    }
    return dataStore.loadJid(localPhone, sock!)
  }

  const validateStatus = async () => {
    if (await sessionStore.isStatusConnecting(phone)) {
      await verifyConnectingTimeout()
      throw new SendError(5, t('connecting_session'))
    } else if (await sessionStore.isStatusDisconnect(phone) || !sock) {
      throw new SendError(3, t('disconnected_session'))
    } else if (await sessionStore.isStatusOffline(phone)) {
      throw new SendError(12, t('offline_session'))
    } else if (await sessionStore.isStatusStandBy(phone)) {
      throw new SendError(14, t('standby', MAX_CONNECT_RETRY, MAX_CONNECT_TIME))
    }
    if (connectingTimeout) {
      clearTimeout(connectingTimeout)
      connectingTimeout = null
    }
  }

  /**
   * Send a message to a target JID.
   * Handles:
   * - Session validation and presence
   * - LID⇄PN normalization when needed
   * - Preassert sessions (1:1 and groups) to reduce decrypt/ack errors
   * - Status/Broadcast normalization (filters invalid numbers, optional LID→PN, deduplication)
   */
  const send: sendMessage = async (
    to: string,
    message: AnyMessageContent,
    // allow passing through any Baileys MiscMessageGenerationOptions plus our custom 'composing'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: any = { composing: false },
  ) => {
    await validateStatus()
    // Prefer LID for 1:1 when possível; manter grupos inalterados
    const forceRemoteJid = options?.forceRemoteJid
    const skipBrSendOrder = options?.skipBrSendOrder
    const forceSessionRefresh = !!(options?.forceSessionRefresh || options?.forceDeliveryRecovery)
    const forceSessionDeviceList = options?.forceDeviceList !== false
    let idCandidate = forceRemoteJid || to
    try {
      if (!forceRemoteJid && isIndividualJid(idCandidate)) {
        if (isLidUser(idCandidate as any)) {
          const authPn = await getPnForLidFromAuthCache(phone, `${idCandidate}`)
          if (authPn && isPnUser(authPn as any)) {
            logger.debug('AUTH_CANONICAL: using PN %s from auth for LID %s', authPn, idCandidate)
            idCandidate = authPn
          }
        } else {
          const raw = ensurePn(`${idCandidate}`)
          if (raw.startsWith('55') && (raw.length === 12 || raw.length === 13)) {
            const to12 = (() => {
              if (raw.length === 12) return raw
              const ddd = raw.slice(2, 4)
              const local9 = raw.slice(4)
              return `55${ddd}${local9.slice(1)}`
            })()
            const to13 = (() => {
              if (raw.length === 13) return raw
              const ddd = raw.slice(2, 4)
              const local = raw.slice(4)
              return /[6-9]/.test(local[0]) ? `55${ddd}9${local}` : raw
            })()
            const variants = Array.from(new Set([to12, to13]))
            for (const variant of variants) {
              const variantJid = `${variant}@s.whatsapp.net`
              const authLid = await getLidForPnFromAuthCache(phone, variantJid)
              if (authLid) {
                if (variantJid !== idCandidate) {
                  logger.warn('AUTH_CANONICAL: overriding destination %s -> %s via auth mapping %s', idCandidate, variantJid, authLid)
                } else {
                  logger.debug('AUTH_CANONICAL: keeping destination %s via auth mapping %s', variantJid, authLid)
                }
                idCandidate = variantJid
                break
              }
            }
          }
        }
      }
    } catch (e) {
      logger.debug(e as any, 'AUTH_CANONICAL: ignore error resolving canonical 1:1 destination')
    }
    let id = forceRemoteJid ? idCandidate : (isIndividualJid(idCandidate) ? await exists(idCandidate) : idCandidate)
    try {
      logger.debug('1:1 resolve: to=%s idCandidate=%s resolved=%s forceRemoteJid=%s skipBrSendOrder=%s brSendOrder=%s', to, idCandidate, id || '<none>', !!forceRemoteJid, !!skipBrSendOrder, !!BR_SEND_ORDER_ENABLED)
    } catch {}
    // BR send-order: tentar 12 dígitos primeiro; se não existir, tentar 13. Webhooks permanecem 13.
    // Quando o input vier como LID, e o modo 1:1 for 'pn', usar o PN resolvido via exists() para aplicar a regra.
    try {
      if (!BR_SEND_ORDER_ENABLED || forceRemoteJid || skipBrSendOrder) {
        // Reactions (and similar) require the exact remote key JID.
        // Do not apply BR heuristics to the destination.
      } else {
        let raw = ensurePn(idCandidate)
      try {
        if ((!raw || raw.length === 0) && ONE_TO_ONE_ADDRESSING_MODE === 'pn') {
          raw = ensurePn(`${id || ''}`)
        }
      } catch {}
      if (raw && raw.startsWith('55') && (raw.length === 12 || raw.length === 13)) {
        const to12 = (() => {
          if (raw.length === 12) return raw
          const ddd = raw.slice(2, 4)
          const local9 = raw.slice(4)
          return `55${ddd}${local9.slice(1)}`
        })()
        const to13 = (() => {
          if (raw.length === 13) return raw
          const ddd = raw.slice(2, 4)
          const local = raw.slice(4)
          return /[6-9]/.test(local[0]) ? `55${ddd}9${local}` : raw
        })()
        let chosen: string | undefined
        try {
          const r12: any = await (sock as any)?.onWhatsApp?.(to12)
          if (Array.isArray(r12) && r12[0]?.exists && r12[0]?.jid) {
            chosen = r12[0].jid
            logger.warn('BR_SEND_ORDER: using 12-digit candidate %s -> %s', to12, chosen)
          }
        } catch {}
        if (!chosen) {
          try {
            const r13: any = await (sock as any)?.onWhatsApp?.(to13)
            if (Array.isArray(r13) && r13[0]?.exists && r13[0]?.jid) {
              chosen = r13[0].jid
              logger.warn('BR_SEND_ORDER: fallback to 13-digit candidate %s -> %s', to13, chosen)
            }
          } catch {}
        }
        if (chosen) {
          id = chosen
        }
      }
      }
    } catch {}
    // preferAddressingMode declarado acima
    // BR 9º dígito: só preferir LID quando o modo 1:1 NÃO for 'pn'.
    // Em modo 'pn', mantemos PN para evitar enviar via LID.
    try {
      if (!BR_SEND_ORDER_ENABLED || forceRemoteJid || skipBrSendOrder) {
        // Skip BR guard when disabled or explicitly bypassed.
      } else if (ONE_TO_ONE_ADDRESSING_MODE !== 'pn') {
        const inDigits = `${idCandidate}`.replace(/\D/g, '')
        const outDigits = `${id || ''}`.split('@')[0].replace(/\D/g, '')
        if (
          inDigits.startsWith('55') && inDigits.length === 13 && inDigits.charAt(4) === '9' &&
          outDigits.startsWith('55') && outDigits.length === 12
        ) {
          try {
            const lid = await (dataStore as any).getLidForPn?.(phone, (id as string))
            if (lid && typeof lid === 'string') {
              logger.warn('BR_GUARD: prefer LID %s over PN mismatch (%s vs %s)', lid, inDigits, outDigits)
              id = lid
            } else {
              logger.warn('BR_GUARD: keeping WA JID %s for send (input=%s); webhook will normalize to 13-digit', id, inDigits)
            }
          } catch {}
        }
      }
    } catch {}
    let preferAddressingMode: WAMessageAddressingMode | undefined = undefined
    try {
      if (id && isIndividualJid(id)) {
        if (ONE_TO_ONE_ADDRESSING_MODE === 'pn') {
          // Força PN: se for LID, tentar obter PN pelo cache/mapeamento e, se necessário, por exists()
          if (isLidUser(id)) {
            try {
              let pnJid: string | undefined
              try { pnJid = await (dataStore as any).getPnForLid?.(phone, id) } catch {}
              if (!pnJid) {
                try { const cand = jidNormalizedUser(id); if (cand && isPnUser(cand as any)) pnJid = cand as any } catch {}
              }
              if (!pnJid) {
                try {
                  const digits = (() => { try { return jidToPhoneNumber(id, '') } catch { return '' } })() || ensurePn(idCandidate)
                  if (digits) {
                    const waJid = await exists(digits)
                    if (waJid && isPnUser(waJid as any)) pnJid = waJid as any
                  }
                } catch {}
              }
              if (pnJid && isPnUser(pnJid as any)) {
                logger.debug('1:1 send: forçando PN %s (de LID %s)', pnJid, id)
                id = pnJid
                preferAddressingMode = WAMessageAddressingMode.PN
              } else {
                // Manter preferência PN para options; id pode seguir LID se PN não for resolvível com segurança
                preferAddressingMode = WAMessageAddressingMode.PN
                logger.debug('1:1 send: preferência PN, mas sem PN resolvido para %s; mantendo destino atual', id)
              }
            } catch {
              preferAddressingMode = WAMessageAddressingMode.PN
            }
          } else {
            preferAddressingMode = WAMessageAddressingMode.PN
          }
        } else {
          // Padrão LID: manter LID; ou, se PN, usar LID se mapeado
          if (isLidUser(id)) {
            preferAddressingMode = WAMessageAddressingMode.LID
            try { scheduleLidResolve(id) } catch {}
          } else {
            try {
              const lid = await (dataStore as any).getLidForPn?.(phone, id)
              if (lid && typeof lid === 'string') {
                logger.debug('1:1 send: trocando alvo para LID %s (a partir do PN %s)', lid, id)
                id = lid
                preferAddressingMode = WAMessageAddressingMode.LID
                try { scheduleLidResolve(id) } catch {}
              }
            } catch {}
          }
        }
      }
    } catch {}
    // For 1:1 sends, proactively assert sessions to reduce decrypt failures and improve ack reliability
    try {
      if (id && isIndividualJid(id)) {
        // Respeita flag e cooldown por destinatário
        let cdKey = id
        try { if (isLidUser(id)) cdKey = jidNormalizedUser(id) } catch {}
        const now = Date.now()
        const last = lastOneToOneAssertAt.get(cdKey) || 0
        // Throttle persistente opcional: guarda o último preassert em Redis
        let redisAllow = true
        const redisTtlSec = ONE_TO_ONE_PREASSERT_REDIS_TTL_SEC || 0
        let redisKey = ''
        if (redisTtlSec > 0) {
          try {
            redisKey = `${BASE_KEY}preassert:1to1:${phone}:${cdKey}`.replace(/[^a-zA-Z0-9:@._-]/g, '_')
            const existing = await redisGet(redisKey)
            if (existing) redisAllow = false
          } catch {}
        }
        const doPreassert =
          (forceSessionRefresh || ONE_TO_ONE_PREASSERT_ENABLED) &&
          !SIGNAL_CACHE_SAFE_MODE &&
          (forceSessionRefresh || redisAllow) &&
          (now - last >= Math.max(0, ONE_TO_ONE_PREASSERT_COOLDOWN_MS || 0))
        const set = new Set<string>()
        set.add(id)
        try {
          if (isLidUser(id)) {
            const pn = jidNormalizedUser(id)
            set.add(pn)
            try { await (dataStore as any).setJidMapping?.(phone, pn, id) } catch {}
          } else if (isPnUser(id)) {
            // BR: ao enviar via PN, incluir o candidato alternativo (12↔13) na afirmação de sessão
            try {
              const digits = ensurePn(id)
              if (digits && digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
                const to12 = (() => {
                  if (digits.length === 12) return digits
                  const ddd = digits.slice(2, 4)
                  const local9 = digits.slice(4)
                  return `55${ddd}${local9.slice(1)}`
                })()
                const to13 = (() => {
                  if (digits.length === 13) return digits
                  const ddd = digits.slice(2, 4)
                  const local = digits.slice(4)
                  return /[6-9]/.test(local[0]) ? `55${ddd}9${local}` : digits
                })()
                const cands = Array.from(new Set([to12, to13])).filter((v) => v && v !== digits)
                for (const cand of cands) {
                  try {
                    const res: any = await (sock as any)?.onWhatsApp?.(cand)
                    if (Array.isArray(res) && res[0]?.exists && res[0]?.jid) {
                      set.add(res[0].jid)
                      try { logger.debug('Preassert BR: added alternate candidate %s -> %s', cand, res[0].jid) } catch {}
                    }
                  } catch {}
                }
              }
            } catch {}
          }
        } catch {}
        try {
          const self = state?.creds?.me?.id
          if (self) {
            set.add(self)
            try { set.add(jidNormalizedUser(self)) } catch {}
          }
        } catch {}
        const targets = Array.from(set)
        if (doPreassert && targets.length) {
          if (forceSessionRefresh || ONE_TO_ONE_PREASSERT_PURGE_DEVICE_LIST) {
            try { await purgeSignalSessionsFor(id, forceSessionDeviceList) } catch {}
          }
          await (sock as any).assertSessions(targets, true)
          lastOneToOneAssertAt.set(cdKey, now)
          if (!forceSessionRefresh && redisTtlSec > 0 && redisKey) {
            try { await redisSetAndExpire(redisKey, '1', redisTtlSec) } catch {}
          }
          logger.debug('Preasserted %s sessions for 1:1 %s (forceSessionRefresh=%s)', targets.length, id, forceSessionRefresh)
          try { if (ONE_TO_ONE_ASSERT_PROBE_ENABLED && (config as any)?.useRedis) await countSignalSessionsForJids(phone, targets) } catch {}
        } else {
          logger.debug('Skip preassert 1:1 (enabled=%s, sinceLast=%sms, cooldown=%sms) for %s', ONE_TO_ONE_PREASSERT_ENABLED, (now - last), ONE_TO_ONE_PREASSERT_COOLDOWN_MS, id)
        }
      }
    } catch (e) {
      logger.warn(e as any, 'Ignore error on preassert 1:1 sessions')
    }
    // For group sends, proactively assert sessions with safeguards for large groups
    try {
      if (id && id.endsWith('@g.us') && GROUP_SEND_PREASSERT_SESSIONS) {
        const gm = await dataStore.loadGroupMetada(id, sock!)
        const raw: string[] = (gm?.participants || [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((p: any) => (p?.id || p?.jid || p?.lid || '').toString())
          .filter((v) => !!v)
        const groupSize = raw.length
        // Flood window guard: avoid re-asserting too frequently for the same group
        try {
          const now = Date.now()
          const last = lastGroupAssert.get(id) || 0
          if (now - last < GROUP_ASSERT_FLOOD_WINDOW_MS) {
            logger.debug('Skip preassert for %s (within flood window %sms)', id, GROUP_ASSERT_FLOOD_WINDOW_MS)
            throw new Error('skip_preassert_flood_window')
          }
          lastGroupAssert.set(id, now)
        } catch {}
        // For very large groups, skip heavy asserts; manter LID como modo preferencial
        if (groupSize > GROUP_LARGE_THRESHOLD) {
          logger.debug('Skip preassert for large group %s (size=%s > %s)', id, groupSize, GROUP_LARGE_THRESHOLD)
          // skip heavy assert entirely for large groups
          throw new Error('skip_preassert_large_group')
        }
        const lids: string[] = []
        const pnsFallback: string[] = []
        for (const j of raw) {
          if (isLidUser(j)) {
            lids.push(j)
            try {
              const pn = jidNormalizedUser(j)
              await (dataStore as any).setJidMapping?.(phone, pn, j)
            } catch {}
          } else {
            try {
              const lid = await (dataStore as any).getLidForPn?.(phone, j)
              if (lid) lids.push(lid)
              else pnsFallback.push(j)
            } catch { pnsFallback.push(j) }
          }
        }
        try {
          const self = state?.creds?.me?.id
          if (self) {
            if (isLidUser(self)) lids.push(self)
            else pnsFallback.push(self)
          }
        } catch {}
        const unique = (arr: string[]) => Array.from(new Set(arr))
        const lidsU = unique(lids)
        const pnsU = unique(pnsFallback)
        const chunkSize = Math.max(20, GROUP_ASSERT_CHUNK_SIZE)
        const assertChunked = async (arr: string[]) => {
          for (let i = 0; i < arr.length; i += chunkSize) {
            const chunk = arr.slice(i, i + chunkSize)
            try { await (sock as any).assertSessions(chunk, true) } catch (ce) { logger.warn(ce as any, 'Ignore error asserting chunk %s-%s', i, i + chunk.length) }
          }
        }
        if (lidsU.length) {
          await assertChunked(lidsU)
        }
        if (pnsU.length) {
          await assertChunked(pnsU)
        }
        try { logger.debug('Preasserted sessions for group %s (LID=%s PN=%s, chunkSize=%s)', id, lidsU.length, pnsU.length, chunkSize) } catch {}
      }
    } catch (e) {
      try {
        const msg = (e as any)?.message || ''
        if (`${msg}`.includes('skip_preassert')) {
          // not an error; informational skip
          logger.debug('Preassert skipped: %s', `${msg}`)
        } else {
          logger.warn(e, 'Ignore error on preassert group sessions')
        }
      } catch { logger.warn(e as any, 'Ignore error on preassert group sessions') }
    }
    if (id) {
      // Block Status (status@broadcast) sending when disabled via env to avoid account risk
      if (id === 'status@broadcast' && !STATUS_BROADCAST_ENABLED) {
        throw new SendError(16, 'status_broadcast_disabled')
      }
      const { composing, ...restOptions } = options || {}
      if (composing) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const i: any = message
        const time = (i?.text?.length || i?.caption?.length || 1) * Math.floor(Math.random() * 100)
        await sock?.presenceSubscribe(id)
        await delay(Math.floor(Math.random() * time) + 100)
        await sock?.sendPresenceUpdate(i?.text ? 'composing' : 'recording', id)
        await delay(Math.floor(Math.random() * time) + 200)
        await sock?.sendPresenceUpdate('paused', id)
      }
      const msgKind = (message && typeof message === 'object') ? Object.keys(message)[0] : typeof message
      logger.debug('%s is sending message ==> %s kind=%s', phone, id, msgKind)
      const opts = { ...restOptions }
      // Aplicar addressingMode preferido para 1:1 quando não houver override explícito
      try {
        if (preferAddressingMode && typeof (opts as any).addressingMode === 'undefined' && isIndividualJid(id)) {
          (opts as any).addressingMode = preferAddressingMode
        }
      } catch {}
      try {
        const keys = (message && typeof message === 'object') ? Object.keys(message) : []
        logger.debug('Send baileys from %s to %s keys=%s', phone, id, JSON.stringify(keys))
      } catch { logger.debug('Send baileys from %s to %s', phone, id) }
      // Workaround for Stories/Status: current Baileys sendMessage() does not pass statusJidList to relayMessage
      if (
        id === 'status@broadcast' &&
        Array.isArray((opts as any).statusJidList) &&
        (opts as any).statusJidList.length > 0
      ) {
        // normalize recipients to real JIDs (may convert to LID JIDs)
        try {
          const originalList: string[] = (opts as any).statusJidList
          // 1) Resolve existence; only keep numbers that actually have WhatsApp
          const resolved = await Promise.all(
            originalList.map(async (v: string) => {
              const raw = `${v}`.trim()
              const jid = await exists(raw)
              return { input: raw, jid }
            })
          )
          const valid = resolved.filter((r) => !!r.jid).map((r) => r.jid as string)
          const skipped = resolved.filter((r) => !r.jid).map((r) => r.input)
          if (skipped.length) {
            logger.warn('Status@broadcast will skip %d invalid numbers (no WhatsApp): %s', skipped.length, JSON.stringify(skipped.slice(0, 10)))
          }
          // 2) Optionally normalize LIDs to PN and deduplicate
          const finalList = STATUS_ALLOW_LID
            ? Array.from(new Set(valid))
            : Array.from(
                new Set(
                  valid.map((jid: string) => {
                    if ((jid || '').includes('@lid')) {
                      const num = jidToPhoneNumber(jid, '')
                      return phoneNumberToJid(num)
                    }
                    return jid
                  })
                )
              )
          ;(opts as any).statusJidList = finalList
          ;(opts as any).__statusSkipped = skipped
          logger.debug('Status@broadcast normalized valid recipients %d', finalList.length)
        } catch (e) {
          logger.warn(e, 'Ignore error normalizing statusJidList')
        }
        const full = await sock?.sendMessage(id, message, opts)
        try {
          // Attach skipped list to response for higher layers to report
          try { (full as any).__statusSkipped = (opts as any).__statusSkipped || [] } catch {}
          if (full?.message) {
            const list: string[] = (opts as any).statusJidList || []
            if (list.length > 0) {
              logger.debug('Relaying status to %s recipients', list.length)
              await sock?.relayMessage(id, full.message, {
                messageId: (full.key.id || undefined) as string | undefined,
                statusJidList: list,
              })
            } else {
              logger.debug('No valid recipients after normalization; skipping relayMessage')
            }
          } else {
            logger.debug('Status@broadcast send returned no message body to relay (key id: %s)', full?.key?.id)
          }
        } catch (error) {
          logger.warn(error, 'Ignore error on relayMessage for status broadcast')
        }
        return full
      } else if (id === 'status@broadcast') {
        // No or empty statusJidList provided; relayMessage will be skipped
        const size = Array.isArray((opts as any).statusJidList) ? (opts as any).statusJidList.length : 'none'
        logger.debug('Status@broadcast without statusJidList (size: %s); skipping relayMessage', size)
      }
      // general path: send, with fallback when libsignal reports missing sessions
      let full
      try {
        // Guarda final: respeitar o modo 1:1 imediatamente antes do envio
        try {
          if (typeof id === 'string' && isIndividualJid(id)) {
            if (ONE_TO_ONE_ADDRESSING_MODE === 'lid' && isPnUser(id)) {
              const lid = await (dataStore as any).getLidForPn?.(phone, id)
              if (lid && typeof lid === 'string') {
                id = lid
                ;(opts as any).addressingMode = WAMessageAddressingMode.LID
              }
            } else if (ONE_TO_ONE_ADDRESSING_MODE === 'pn' && isLidUser(id)) {
              let pnJid: string | undefined
              try { pnJid = await (dataStore as any).getPnForLid?.(phone, id) } catch {}
              if (!pnJid) {
                try { const cand = jidNormalizedUser(id); if (cand && isPnUser(cand as any)) pnJid = cand as any } catch {}
              }
              if (!pnJid) {
                try {
                  const digits = (() => { try { return jidToPhoneNumber(id, '') } catch { return '' } })() || ensurePn(idCandidate)
                  if (digits) {
                    const waJid = await exists(digits)
                    if (waJid && isPnUser(waJid as any)) pnJid = waJid as any
                  }
                } catch {}
              }
              if (pnJid && isPnUser(pnJid as any)) {
                id = pnJid
                ;(opts as any).addressingMode = WAMessageAddressingMode.PN
              }
            }
          }
        } catch {}
        full = await sock?.sendMessage(id, message, opts)
      } catch (err: any) {
        const msg = (err?.message || `${err || ''}`).toString().toLowerCase()
        const isNoSessions = msg.includes('no sessions') || msg.includes('nosessions')
        if (isNoSessions && typeof id === 'string' && id.endsWith('@g.us')) {
          try {
            // Flood window guard per group
            const now = Date.now()
            const last = lastGroupAssert.get(id) || 0
            if (now - last < GROUP_ASSERT_FLOOD_WINDOW_MS) {
              logger.warn('Skip heavy assert for %s (within flood window %sms)', id, GROUP_ASSERT_FLOOD_WINDOW_MS)
              throw err
            }
            lastGroupAssert.set(id, now)
            // Re-assert sessions for group participants (including PN/LID variants) and retry once
            const gm = await dataStore.loadGroupMetada(id, sock!)
            const raw: string[] = (gm?.participants || [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((p: any) => (p?.id || p?.jid || p?.lid || '').toString())
              .filter((v) => !!v)
            // Prefer LID targets when asserting sessions
            const lids: string[] = []
            const pnsFallback: string[] = []
            for (const j of raw) {
              if (isLidUser(j)) {
                lids.push(j)
              } else {
                try {
                  const lid = await (dataStore as any).getLidForPn?.(phone, j)
                  if (lid) lids.push(lid)
                  else pnsFallback.push(j)
                } catch { pnsFallback.push(j) }
              }
            }
            try {
              const self = state?.creds?.me?.id
              if (self) {
                if (isLidUser(self)) lids.push(self)
                else pnsFallback.push(self)
              }
            } catch {}
            const targets = Array.from(new Set([...lids, ...pnsFallback]))
            const groupSize = raw.length
            // If the group is very large, avoid heavy asserts and rely on PN addressing + delays
            if (groupSize > GROUP_LARGE_THRESHOLD) {
              const extra = Math.min(NO_SESSION_RETRY_MAX_DELAY_MS, (Math.ceil(groupSize / 200) * NO_SESSION_RETRY_PER_200_DELAY_MS))
              logger.warn('Large group (%s) detected for %s; skipping heavy assert and retrying after %sms', groupSize, id, NO_SESSION_RETRY_BASE_DELAY_MS + extra)
              try { await delay(NO_SESSION_RETRY_BASE_DELAY_MS + extra) } catch {}
              full = await sock?.sendMessage(id, message, opts)
              // If still fails, fall into catch to toggle addressingMode
              return full
            }
            if (targets.length) {
              // Try bulk first, then chunked, then split-by-scheme (LID vs PN) chunked
              const chunkSize = Math.max(20, GROUP_ASSERT_CHUNK_SIZE)
              const assertChunked = async (arr: string[]) => {
                for (let i = 0; i < arr.length; i += chunkSize) {
                  const chunk = arr.slice(i, i + chunkSize)
                  try {
                    await (sock as any).assertSessions(chunk, true)
                  } catch (ce) {
                    logger.warn(ce as any, 'Ignore error asserting chunk %s-%s', i, i + chunk.length)
                  }
                }
              }
              try {
                await (sock as any).assertSessions(targets, true)
                logger.warn('Recovered from No sessions by asserting %s targets for group %s; retrying send', targets.length, id)
              } catch (ae) {
                logger.warn(ae as any, 'Bulk assertSessions failed; retrying in chunks')
                await assertChunked(targets)
                // Split by LID vs PN and assert again (some servers behave better separated)
                const lids = targets.filter(j => j.includes('@lid'))
                const pns = targets.filter(j => !j.includes('@lid'))
                try { if (lids.length) await assertChunked(lids) } catch {}
                try { if (pns.length) await assertChunked(pns) } catch {}
              }
              // Adaptive delay based on fanout size to let sender keys propagate
              const extra = Math.min(NO_SESSION_RETRY_MAX_DELAY_MS, (Math.ceil(targets.length / 200) * NO_SESSION_RETRY_PER_200_DELAY_MS))
              try { await delay(NO_SESSION_RETRY_BASE_DELAY_MS + extra) } catch {}
            }
            full = await sock?.sendMessage(id, message, opts)
          } catch (e) {
            logger.warn(e as any, 'Retry after No sessions failed')
            // Last attempt: toggle addressingMode and try once more
            try {
              const altOpts: any = { ...(opts || {}) }
              try {
                const curr = (opts as any)?.addressingMode
                if (curr === WAMessageAddressingMode.LID) altOpts.addressingMode = WAMessageAddressingMode.PN
                else altOpts.addressingMode = WAMessageAddressingMode.LID
              } catch {}
              logger.warn('Toggling addressingMode to attempt recovery from No sessions on %s', id)
              // small wait to avoid hammering
              try { await delay(120) } catch {}
              full = await sock?.sendMessage(id, message, altOpts)
            } catch (ee) {
              logger.warn(ee as any, 'Final retry after No sessions failed')
              throw err
            }
          }
        } else {
          throw err
        }
      }
      try {
        if (full?.key?.id && typeof id === 'string' && id.endsWith('@g.us')) {
          let mode: 'pn' | 'lid' | '' = ''
          try {
            const m = (opts as any).addressingMode
            mode = m === WAMessageAddressingMode.LID ? 'lid' : m === WAMessageAddressingMode.PN ? 'pn' : ''
          } catch {}
          pendingGroupSends.set(full.key.id, { to: id, message, options: { ...opts }, attempted: new Set([mode]), retries: 0 })
        }
      } catch (e) {
        logger.warn(e as any, 'Ignore error tracking pending group send')
      }
      // Schedule ack/delivery watchers (1:1 e grupos)
      try {
        const mid = (full as any)?.key?.id as string | undefined
        if (mid) {
          if (typeof id === 'string' && isIndividualJid(id)) {
            const existing = pendingOneToOneErrorFallbacks.get(mid)
            if (existing?.timer) {
              try { clearTimeout(existing.timer) } catch {}
            }
            const entry = { to: id, message, options: { ...opts }, timer: undefined as NodeJS.Timeout | undefined }
            entry.timer = setTimeout(() => {
              try {
                const current = pendingOneToOneErrorFallbacks.get(mid)
                if (current?.timer === entry.timer) pendingOneToOneErrorFallbacks.delete(mid)
              } catch {}
            }, 90_000) as unknown as NodeJS.Timeout
            pendingOneToOneErrorFallbacks.set(mid, entry)
          }
          scheduleAckWatch(id, mid, message, opts)
          scheduleDeliveryWatch(id, mid, message, opts)
          scheduleStaleDeliveryRecovery(id, mid, message, opts)
        }
      } catch {}
      // Se habilitado, marcar como lida a última mensagem recebida deste chat ao responder
      try {
        if (config.readOnReply && id) {
          // Normaliza PN e cobre variantes PN<->LID para localizar o ponteiro correto, independente do modo de endereçamento
          let pnTarget = normalizeReceiptJid(id) || id
          try { if (isLidUser(pnTarget)) pnTarget = jidNormalizedUser(pnTarget) } catch {}
          const candidates = new Set<string>()
          // PN normalizado
          try { if (typeof pnTarget === 'string') candidates.add(pnTarget) } catch {}
          // JID original (pode ser LID)
          try {
            if (typeof id === 'string') {
              candidates.add(id)
              const normalizedId = normalizeReceiptJid(id)
              if (normalizedId) candidates.add(normalizedId)
            }
          } catch {}
          // Cobre diferença BR 8/9 dígitos quando a entrada foi salva com outra forma do mesmo PN
          try {
            if (typeof pnTarget === 'string' && isPnUser(pnTarget)) {
              const digits = pnTarget.split('@')[0].split(':')[0].replace(/\D/g, '')
              if (digits) {
                candidates.add(`${digits}@s.whatsapp.net`)
                candidates.add(phoneNumberToJid(digits))
              }
            }
          } catch {}
          // Se estamos com PN, tente o LID mapeado para garantir ponteiro de aparelho que usa LID
          try {
            if (typeof pnTarget === 'string' && isPnUser(pnTarget)) {
              const lid = await (dataStore as any).getLidForPn?.(phone, pnTarget)
              if (lid && typeof lid === 'string') candidates.add(lid)
              const authLid = await getLidForPnFromAuthCache(phone, pnTarget)
              if (authLid && typeof authLid === 'string') candidates.add(authLid)
            }
          } catch {}
          const order = Array.from(candidates)
          logger.debug('READ_ON_REPLY: enabled for %s (candidates=%s)', id, JSON.stringify(order))
          let lastKey: any | undefined
          for (const j of order) {
            try { lastKey = await dataStore.getLastIncomingKey?.(j); if (lastKey) break } catch {}
          }
          if (lastKey && lastKey.remoteJid && lastKey.id && !lastKey.fromMe) {
            // Normaliza para o id do provedor (Baileys), caso lastKey contenha UNO id
            let keyForRead = lastKey as any
            try {
              const original = await dataStore.loadKey?.(lastKey.id as any)
              if (original && (original as any).id && (original as any).remoteJid) {
                keyForRead = original
              }
            } catch {}
            try {
              keyForRead = {
                ...(keyForRead || {}),
                remoteJid: normalizeReceiptJid((keyForRead as any)?.remoteJid) || (keyForRead as any)?.remoteJid,
                participant: normalizeReceiptJid((keyForRead as any)?.participant) || (keyForRead as any)?.participant,
              }
            } catch {}
            logger.info('READ_ON_REPLY: reading last incoming id=%s jid=%s', (keyForRead as any).id, (keyForRead as any).remoteJid)
            await read([keyForRead])
          } else {
            logger.debug('READ_ON_REPLY: no last incoming pointer for any of %s', JSON.stringify(order))
          }
        }
      } catch (e) {
        logger.warn(e as any, 'Ignore error on readOnReply')
      }
      return full
    }
    // Se id resolvido já é um JID (@s.whatsapp.net ou @lid), não classificar como telefone inválido
    try {
      if (typeof id === 'string' && (id.includes('@s.whatsapp.net') || id.includes('@lid'))) {
        throw new SendError(2, t('without_whatsapp', to))
      }
    } catch {}
    if (!isValidPhoneNumber(to)) {
      throw new SendError(7, t('invalid_phone_number', to))
    }
    throw new SendError(2, t('without_whatsapp', to))
  }

  const read: readMessages = async (keys: WAMessageKey[]) => {
    await validateStatus()
    keys = (keys || []).map((key: any) => ({
      ...(key || {}),
      remoteJid: normalizeReceiptJid(key?.remoteJid) || key?.remoteJid,
      participant: normalizeReceiptJid(key?.participant) || key?.participant,
    }))

    // Proactively assert sessions for the message recipients to avoid 'No sessions' on receipts/deletes
    try {
      const targets = new Set<string>()
      for (const k of keys || []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ka: any = k as any
        const remote = k?.remoteJid || ka?.remoteJidAlt
        const participant = k?.participant || ka?.participantAlt
        if (remote) {
          targets.add(remote)
          try { if (isLidUser(remote)) targets.add(jidNormalizedUser(remote)) } catch {}
        }
        if (participant) {
          targets.add(participant)
          try { if (isLidUser(participant)) targets.add(jidNormalizedUser(participant)) } catch {}
        }
      }
      if (targets.size) {
        await (sock as any).assertSessions(Array.from(targets), true)
      }
    } catch (e) {
      logger.warn(e as any, 'Ignore error asserting sessions before readMessages')
    }

    await sock?.readMessages(keys)
    return true
  }

  if (config.autoRestartMs) {
    const message = t('auto_restart', config.autoRestartMs)
    await onNotification(message, true)
    setInterval(reconnect, config.autoRestartMs)
  }

  const rejectCall: rejectCall = async (callId: string, callFrom: string) => {
    await validateStatus()
    // A rejeição precisa usar o mesmo identificador que originou o evento de chamada.
    // Apenas removemos sufixo técnico de device (:NN) para não enviar JID inválido ao Baileys.
    let target = normalizeReceiptJid(callFrom) || callFrom
    logger.info('CALL_REJECT final target: callId=%s from=%s target=%s', callId, callFrom, target)
    try {
      const result = await sock?.rejectCall(callId, target)
      logger.info('CALL_REJECT sent: callId=%s target=%s', callId, target)
      return result
    } catch (error) {
      logger.warn({ err: error, callId, callFrom, target }, 'CALL_REJECT send failed')
      throw error
    }
  }

  const sendCallNode: sendCallNode = async (node: BinaryNode) => {
    await validateStatus()
    if (!node || node.tag !== 'call') throw new Error('invalid_call_node')
    await (sock as any)?.sendNode?.(node)
  }

  const groupCreate: groupCreate = async (subject: string, participants: string[]) => {
    await validateStatus()
    return (sock as any).groupCreate(subject, participants)
  }

  const groupUpdateSubject: groupUpdateSubject = async (jid: string, subject: string) => {
    await validateStatus()
    return (sock as any).groupUpdateSubject(jid, subject)
  }

  const groupUpdateDescription: groupUpdateDescription = async (jid: string, description?: string) => {
    await validateStatus()
    return (sock as any).groupUpdateDescription(jid, description)
  }

  const groupUpdatePicture: groupUpdatePicture = async (jid: string, pictureUrl: string) => {
    await validateStatus()
    return (sock as any).updateProfilePicture(jid, { url: pictureUrl })
  }

  const groupParticipantsUpdate: groupParticipantsUpdate = async (jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') => {
    await validateStatus()
    return (sock as any).groupParticipantsUpdate(jid, participants, action)
  }

  const groupInviteCode: groupInviteCode = async (jid: string) => {
    await validateStatus()
    return (sock as any).groupInviteCode(jid)
  }

  const groupRevokeInvite: groupInviteCode = async (jid: string) => {
    await validateStatus()
    return (sock as any).groupRevokeInvite(jid)
  }

  const groupRequestParticipantsList: groupRequestParticipantsList = async (jid: string) => {
    await validateStatus()
    return (sock as any).groupRequestParticipantsList(jid)
  }

  const groupRequestParticipantsUpdate: groupRequestParticipantsUpdate = async (jid: string, participants: string[], action: 'approve' | 'reject') => {
    await validateStatus()
    return (sock as any).groupRequestParticipantsUpdate(jid, participants, action)
  }

  const groupLeave: groupLeave = async (jid: string) => {
    await validateStatus()
    return (sock as any).groupLeave(jid)
  }

  const groupSettingUpdate: groupSettingUpdate = async (jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') => {
    await validateStatus()
    return (sock as any).groupSettingUpdate(jid, setting)
  }

  const groupJoinApprovalMode: groupJoinApprovalMode = async (jid: string, mode: 'on' | 'off') => {
    await validateStatus()
    return (sock as any).groupJoinApprovalMode(jid, mode)
  }

  const fetchImageUrl: fetchImageUrl = async (jid: string) => {
    return dataStore.loadImageUrl(jid, sock!)
  }

  const fetchGroupMetadata: fetchGroupMetadata = async (jid: string) => {
    return dataStore.loadGroupMetada(jid, sock!)
  }

  const groupMetadata: groupMetadata = async (jid: string) => {
    await validateStatus()
    return sock?.groupMetadata(jid)
  }

  const connect = async () => {
    await sessionStore.syncConnection(phone)
    if (await sessionStore.isStatusOnline(phone)) {
      logger.warn('Already Connected %s', phone)
      return
    }
    if (await sessionStore.verifyStatusStandBy(phone)) {
      logger.warn('Standby %s', phone)
      return
    }
    logger.debug('Connecting %s', phone)

    let browser: WABrowserDescription = DEFAULT_BROWSER as WABrowserDescription

    const loggerBaileys = MAIN_LOGGER.child({})
    logger.level = config.logLevel as Level
    loggerBaileys.level = (LOG_LEVEL) as Level

    let agent
    let fetchAgent
    if (config.proxyUrl) {
      agent = new SocksProxyAgent(config.proxyUrl)
      try {
        const undici: any = await import('undici')
        // @ts-ignore - ProxyAgent typing depends on undici version
        fetchAgent = new undici.ProxyAgent(config.proxyUrl)
      } catch (e) {
        logger.warn(e as any, 'Proxy configured but undici ProxyAgent not available; fetch uploads will not use proxy')
      }
    }
    historyAlreadySynced = await getHistorySyncMarker(phone)
    historySyncInProgress = false
    const allowFullHistoryForSession = !config.ignoreHistoryMessages && (!historyAlreadySynced || config.allowFullHistorySync)
    const socketConfig: UserFacingSocketConfig = {
      auth: state,
      logger: loggerBaileys,
      markOnlineOnConnect: config.markOnlineOnConnect !== false,
      syncFullHistory: allowFullHistoryForSession,
      shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => {
        const syncType = msg?.syncType as proto.HistorySync.HistorySyncType | undefined
        const syncTypeName = historySyncTypeName(syncType)
        const shouldSync = shouldAcceptHistorySync(syncType, config, { historyAlreadySynced, historySyncInProgress })
        if (shouldSync && [
          proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
          proto.HistorySync.HistorySyncType.ON_DEMAND,
          proto.HistorySync.HistorySyncType.FULL,
        ].includes(syncType as any)) {
          historySyncInProgress = true
          setHistorySyncMarker(phone, {
            status: 'started',
            syncType: syncTypeName,
            startedAt: new Date().toISOString(),
          }).catch(() => {})
        }
        try {
          logger.info(
            'History sync decision %s syncType=%s chunkOrder=%s progress=%s phone=%s historyAlreadySynced=%s historySyncInProgress=%s',
            shouldSync ? 'accept' : 'skip',
            syncTypeName,
            `${msg?.chunkOrder ?? '<none>'}`,
            `${msg?.progress ?? '<none>'}`,
            phone,
            historyAlreadySynced,
            historySyncInProgress,
          )
        } catch {}
        return shouldSync
      },
      getMessage,
      shouldIgnoreJid: config.shouldIgnoreJid,
      retryRequestDelayMs: config.retryRequestDelayMs,
      msgRetryCounterCache,
      // patchMessageBeforeSending,
      agent,
      fetchAgent,
      qrTimeout: config.qrTimeoutMs,
      countryCode: `${(config as any).baileysCountryCode || 'BR'}`.toUpperCase(),
    }
    if (whatsappVersion) {
      socketConfig.version = whatsappVersion
      resolvedWhatsappVersion = whatsappVersion
    } else {
      try {
        const fetchVer: any = fetchLatestWaWebVersion as any
        let version: [number, number, number] | number[] | undefined
        try {
          const res = await fetchVer({
            headers: {
              'sec-fetch-site': 'none',
              'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            }
          })
          version = res?.version || res
        } catch {
          const res = await fetchVer()
          version = res?.version || res
        }
        if (!Array.isArray(version) || version.length < 3) throw new Error('invalid WA version response')
        const normalizedVersion: [number, number, number] = [version[0], version[1], version[2]]
        socketConfig.version = normalizedVersion
        resolvedWhatsappVersion = normalizedVersion as any
        logger.debug('Using latest WA Web version %s', JSON.stringify(normalizedVersion))
      } catch (e) {
        logger.warn(e as any, 'Failed to fetch WA Web version; using default')
      }
    }
    if (config.connectionType == 'pairing_code') {
      socketConfig.printQRInTerminal = false
      socketConfig.browser = Browsers.ubuntu('Chrome')
    } else {
      if (!config.ignoreHistoryMessages) {
        browser = Browsers.ubuntu('Chrome')
      }
      // Evita aviso deprecatado; QR é tratado via connection.update
      socketConfig.printQRInTerminal = false
      socketConfig.browser = browser
    }

    if (config.clearAppStateSyncOnConnect) {
      // Emergency self-heal for stale app-state keys; forces Baileys to fetch a fresh snapshot.
      try {
        await (state as any)?.keys?.set?.({
          'app-state-sync-version': {
            'regular_high': undefined,
            'regular_low': undefined,
            'critical_unblock_low': undefined,
          }
        })
        logger.debug('Cleared app-state-sync-version entries (regular_high/regular_low/critical_unblock_low) before connect')
      } catch (e) {
        logger.debug('Ignore error clearing app-state-sync-version before connect: %s', (e as any)?.message || e)
      }
    }

    try {
      const proxy = makeWASocket(socketConfig)
      const handler = {
        apply: (target, _thisArg, argumentsList) => {
          try {
            return target(...argumentsList)
          } catch (error) {
            console.error(error, error.isBoom, !error.isServer)
            if (error && error.isBoom && !error.isServer) {
              onClose({ lastDisconnect: { error } })
              return
            } else {
              throw error
            }
          }
        }
      }
      sock = new Proxy(proxy, handler)
    } catch (error: any) {
      console.log(error, error.isBoom, !error.isServer)
      if (error && error.isBoom && !error.isServer) {
        await onClose({ lastDisconnect: { error } })
        return false
      } else {
        logger.error('baileys Socket error: %s %s', error, error.stack)
        const message = t('error', error.message)
        await onNotification(message, true)
        throw error
      }
    }
    if (sock) {
      try {
        ;(sock as any)?.ws?.on?.('CB:call', async (node: BinaryNode) => {
          try {
            const cb = eventsMap.get('call.raw' as any)
            if (cb) await cb(node as any)
          } catch (e) {
            logger.warn(e as any, 'Ignore error on call.raw handler')
          }
        })
      } catch (e) {
        logger.warn(e as any, 'Ignore error registering raw call listener')
      }
      event('connection.update', onConnectionUpdate)
      event('creds.update', verifyAndSaveCreds)
      sock.ev.process(async(events) => {
        if (events && Object.keys(events).length) {
          touchSocketActivity()
        }
        const keys = Object.keys(events)
        for(const i in keys) {
          const key = keys[i]
          if (eventsMap.has(key)) {
            eventsMap.get(key)(events[key])
          }
        }
      })
      logger.info('Connection type %s already creds %s', config.connectionType, sock?.authState?.creds?.registered)
      if (config.connectionType == 'pairing_code' && !sock?.authState?.creds?.registered) {
        logger.info(`Requesting pairing code ${phone}`)
        try {
          // await sock.waitForConnectionUpdate(async (update) => !!update.qr)
          const onlyNumbers = phone.replace(/[^0-9]/g, '')
          const code = await sock?.requestPairingCode(onlyNumbers)
          const beatyCode = `${code?.match(/.{1,4}/g)?.join('-')}`
          const message = t('pairing_code', beatyCode)
          await onNotification(message, true)
        } catch (error) {
          console.error(error)
          throw error
        }
      }
      // Start background LID->PN resolver loop
      try { ensureLidResolverTimer() } catch {}
      // Enriquecer JIDMAP a partir de contact-info (quando Redis habilitado)
      return true
    }
    return false
  }

  if (!await connect()) {
    await sessionStore.setStatus(phone, 'offline')
    return
  }

  return {
    event,
    status,
    send,
    read,
    rejectCall,
    sendCallNode,
    fetchImageUrl,
    fetchGroupMetadata,
    groupMetadata,
    exists,
    close,
    logout,
    groupCreate,
    groupUpdateSubject,
    groupUpdateDescription,
    groupUpdatePicture,
    groupParticipantsUpdate,
    groupInviteCode,
    groupRevokeInvite,
    groupRequestParticipantsList,
    groupRequestParticipantsUpdate,
    groupLeave,
    groupSettingUpdate,
    groupJoinApprovalMode,
  }
}
