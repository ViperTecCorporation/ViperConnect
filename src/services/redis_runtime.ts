import { getRedis, startRedis } from './redis'

export const requiredRedisUrl = (environment: NodeJS.ProcessEnv = process.env): string => {
  const url = `${environment.REDIS_URL || ''}`.trim()
  if (!url) {
    throw new Error('REDIS_URL is required. UnoAPI does not support running without Redis.')
  }
  return url
}

export const ensureRequiredRedis = async (environment: NodeJS.ProcessEnv = process.env): Promise<void> => {
  const url = requiredRedisUrl(environment)
  await startRedis(url)
  const redis = await getRedis(url)
  await redis.ping()
}
