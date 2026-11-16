import { PASSKEY_BRIDGE_TTL_SECONDS } from '../defaults'
import { BASE_KEY, getRedis, redisGet, redisSetAndExpire, redisDelKey, redisScanSome } from './redis'
import logger from './logger'
import { SendError } from './send_error'

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

export const PASSKEY_BRIDGE_CAS_LUA = `
local current=redis.call('GET',KEYS[1]);
if current~=ARGV[1] then return 0 end;
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000);
if tonumber(ARGV[3])<=now then return -1 end;
redis.call('SET',KEYS[1],ARGV[2],'PXAT',ARGV[3]); return 1;
`

export const updatePasskeyBridgeSession = async (bridgeId: string, patch: Partial<PasskeyBridgeSession>) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await redisGet(key(bridgeId))
    if (!raw) return undefined
    let current: PasskeyBridgeSession
    try { current = JSON.parse(raw) } catch { return undefined }
    if (!current || current.bridgeId !== bridgeId || typeof current.phone !== 'string') return undefined
    const expiresAt = Date.parse(current.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined
    if (['completed', 'timeout', 'error'].includes(current.status)) return current
    const next: PasskeyBridgeSession = {
      ...current,
      ...patch,
      bridgeId: current.bridgeId,
      phone: current.phone,
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
      updatedAt: new Date().toISOString(),
    }
    const stored = await (await getRedis()).eval(PASSKEY_BRIDGE_CAS_LUA, { keys: [key(bridgeId)], arguments: [raw, JSON.stringify(next), String(expiresAt)] })
    if (stored === 1) return next
    if (stored === -1) return undefined
  }
  throw new SendError(409, 'passkey_bridge_update_conflict')
}

export const deletePasskeyBridgeSession = async (bridgeId: string) => redisDelKey(key(bridgeId))
