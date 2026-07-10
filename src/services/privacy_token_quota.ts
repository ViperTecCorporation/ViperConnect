import { v1 as uuid } from 'uuid'
import {
  UNOAPI_MISSING_TC_TOKEN_GUARD_ENABLED,
  UNOAPI_MISSING_TC_TOKEN_LIMIT,
  UNOAPI_MISSING_TC_TOKEN_WINDOW_HOURS,
} from '../defaults'
import logger from './logger'
import {
  BASE_KEY,
  redisExpire,
  redisZAdd,
  redisZCount,
  redisZRangeWithScores,
  redisZRemRangeByScore,
} from './redis'

export type MissingTcTokenQuotaStatus = {
  enabled: boolean
  limit: number
  used: number
  remaining: number
  windowHours: number
  resetAt?: string
  blocked: boolean
}

export type MissingTcTokenQuotaDecision = MissingTcTokenQuotaStatus & {
  allowed: boolean
  reason?: 'missing_tc_token_quota_exceeded'
}

const windowMs = () => Math.max(1, UNOAPI_MISSING_TC_TOKEN_WINDOW_HOURS || 24) * 60 * 60 * 1000
const windowSec = () => Math.ceil(windowMs() / 1000)
const ttlSec = () => windowSec() + 3600

export const missingTcTokenQuotaKey = (phone: string) =>
  `${BASE_KEY}missing-tctoken:${`${phone || ''}`.replace(/\D/g, '')}`

const cleanup = async (key: string, now: number) => {
  await redisZRemRangeByScore(key, 0, now - windowMs())
}

const resetAtFromOldest = async (key: string): Promise<string | undefined> => {
  const oldest = await redisZRangeWithScores(key, 0, 0)
  const score = oldest?.[0]?.score
  return Number.isFinite(score) ? new Date(score + windowMs()).toISOString() : undefined
}

export const getMissingTcTokenQuotaStatus = async (phone: string): Promise<MissingTcTokenQuotaStatus> => {
  const enabled = UNOAPI_MISSING_TC_TOKEN_GUARD_ENABLED
  const limit = Math.max(0, UNOAPI_MISSING_TC_TOKEN_LIMIT || 40)
  const key = missingTcTokenQuotaKey(phone)
  const now = Date.now()
  await cleanup(key, now)
  const used = await redisZCount(key, now - windowMs(), now)
  const resetAt = used > 0 ? await resetAtFromOldest(key) : undefined
  return {
    enabled,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    windowHours: Math.max(1, UNOAPI_MISSING_TC_TOKEN_WINDOW_HOURS || 24),
    resetAt,
    blocked: enabled && limit > 0 && used >= limit,
  }
}

export const checkMissingTcTokenQuota = async (phone: string): Promise<MissingTcTokenQuotaDecision> => {
  try {
    const status = await getMissingTcTokenQuotaStatus(phone)
    return {
      ...status,
      allowed: !status.blocked,
      reason: status.blocked ? 'missing_tc_token_quota_exceeded' : undefined,
    }
  } catch (error) {
    logger.warn(error as any, 'Missing tctoken quota check failed; allowing send for %s', phone)
    return {
      enabled: false,
      limit: Math.max(0, UNOAPI_MISSING_TC_TOKEN_LIMIT || 40),
      used: 0,
      remaining: Math.max(0, UNOAPI_MISSING_TC_TOKEN_LIMIT || 40),
      windowHours: Math.max(1, UNOAPI_MISSING_TC_TOKEN_WINDOW_HOURS || 24),
      blocked: false,
      allowed: true,
    }
  }
}

export const recordMissingTcTokenSend = async (phone: string, messageId?: string): Promise<MissingTcTokenQuotaStatus | undefined> => {
  if (!UNOAPI_MISSING_TC_TOKEN_GUARD_ENABLED || (UNOAPI_MISSING_TC_TOKEN_LIMIT || 40) <= 0) return undefined
  try {
    const key = missingTcTokenQuotaKey(phone)
    const now = Date.now()
    await cleanup(key, now)
    await redisZAdd(key, now, `${now}:${messageId || uuid()}`)
    await redisExpire(key, ttlSec())
    return getMissingTcTokenQuotaStatus(phone)
  } catch (error) {
    logger.warn(error as any, 'Missing tctoken quota record failed for %s', phone)
    return undefined
  }
}
