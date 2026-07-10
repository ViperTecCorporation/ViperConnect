import { PASSKEY_BRIDGE_TTL_SECONDS } from '../defaults'
import { BASE_KEY, redisGet, redisSetAndExpire, redisDelKey, redisScanSome } from './redis'
import logger from './logger'

export type PasskeyBridgeStatus =
  | 'request'
  | 'response-sent'
  | 'confirmation'
  | 'completed'
  | 'timeout'
  | 'error'

export type PasskeyBridgeSession = {
  bridgeId: string
  phone: string
  status: PasskeyBridgeStatus
  requestOptionsBase64Url?: string
  requestOptionsJson?: any
  code?: string
  skipHandoffUX?: boolean
  error?: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

const key = (bridgeId: string) => `${BASE_KEY}passkey-bridge:${bridgeId}`

export const toBase64Url = (value: Buffer) => value
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/g, '')

export const fromBase64Url = (value: string) => {
  const raw = `${value || ''}`.replace(/-/g, '+').replace(/_/g, '/')
  const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64')
}

const parseRequestOptions = (requestOptions: Buffer) => {
  try {
    return JSON.parse(requestOptions.toString('utf8'))
  } catch {
    return undefined
  }
}

const ttlSeconds = () => Math.max(30, PASSKEY_BRIDGE_TTL_SECONDS || 120)

export const createPasskeyBridgeSession = async (phone: string, bridgeId: string, requestOptions: Buffer) => {
  const now = new Date()
  const ttl = ttlSeconds()
  const payload: PasskeyBridgeSession = {
    bridgeId,
    phone,
    status: 'request',
    requestOptionsBase64Url: toBase64Url(requestOptions),
    requestOptionsJson: parseRequestOptions(requestOptions),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  }
  await redisSetAndExpire(key(bridgeId), JSON.stringify(payload), ttl)
  logger.info('PASSKEY bridge request: phone=%s bridgeId=%s ttl=%ss', phone, bridgeId, ttl)
  return payload
}

export const getPasskeyBridgeSession = async (bridgeId: string): Promise<PasskeyBridgeSession | undefined> => {
  const raw = await redisGet(key(bridgeId))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as PasskeyBridgeSession
  } catch (error) {
    logger.warn(error as any, 'Invalid passkey bridge payload %s', bridgeId)
    return undefined
  }
}

export const listPasskeyBridgeSessions = async (limit = 200): Promise<PasskeyBridgeSession[]> => {
  const keys = await redisScanSome(`${BASE_KEY}passkey-bridge:*`, limit)
  const sessions: PasskeyBridgeSession[] = []
  for (const itemKey of keys) {
    const bridgeId = itemKey.split(':').pop() || ''
    const session = bridgeId ? await getPasskeyBridgeSession(bridgeId) : undefined
    if (session) sessions.push(session)
  }
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export const updatePasskeyBridgeSession = async (bridgeId: string, patch: Partial<PasskeyBridgeSession>) => {
  const current = await getPasskeyBridgeSession(bridgeId)
  if (!current) return undefined
  const next: PasskeyBridgeSession = {
    ...current,
    ...patch,
    bridgeId: current.bridgeId,
    phone: current.phone,
    updatedAt: new Date().toISOString(),
  }
  const expiresAt = Date.parse(next.expiresAt)
  const ttl = Number.isFinite(expiresAt) ? Math.max(30, Math.ceil((expiresAt - Date.now()) / 1000)) : ttlSeconds()
  await redisSetAndExpire(key(bridgeId), JSON.stringify(next), ttl)
  return next
}

export const deletePasskeyBridgeSession = async (bridgeId: string) => redisDelKey(key(bridgeId))
