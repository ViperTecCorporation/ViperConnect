import { BUFFER_LIMIT, COMPONENT_LIMIT, ResourceSample, LIVE_MS } from './types'

export interface MetricsRedis { isReady?: boolean; sendCommand(args: string[], options?: { signal: AbortSignal }): Promise<any> }
export const stackId = () => {
  const value = process.env.RESOURCE_METRICS_STACK_ID || process.env.UNOAPI_QUEUE_NAME || 'unoapi'
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) throw new Error('resource_metrics_stack_id_invalid')
  return value
}

export class ResourceMetricsStore {
  readonly prefix: string
  readonly redis: MetricsRedis
  constructor(redis: MetricsRedis, readonly stack = stackId()) {
    this.prefix = `unoapi-resource-metrics:${stack}:`
    this.redis = { sendCommand: args => {
      if (redis.isReady === false) return Promise.reject(new Error('resource_metrics_redis_unavailable'))
      return redis.sendCommand(args, { signal: AbortSignal.timeout(2000) })
    } }
  }
  async save(sample: ResourceSample) {
    const body = JSON.stringify(sample)
    if (body.length > 8192) throw new Error('resource_metrics_sample_too_large')
    const minute = Math.floor(sample.t / 60000) * 60000
    const result = await this.redis.sendCommand(['EVAL', `
      redis.call('SET',KEYS[1],ARGV[1],'EX',604800)
      redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3])
      redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',tonumber(ARGV[2])-604800000)
      redis.call('ZREMRANGEBYRANK',KEYS[2],0,-${COMPONENT_LIMIT + 1})
      redis.call('ZREMRANGEBYSCORE',KEYS[3],ARGV[4],ARGV[4])
      redis.call('ZADD',KEYS[3],ARGV[4],ARGV[1])
      local removed=redis.call('ZREMRANGEBYRANK',KEYS[3],0,-${BUFFER_LIMIT + 1})
      redis.call('EXPIRE',KEYS[3],10800)
      return removed`, '3', this.prefix + 'latest:' + sample.id, this.prefix + 'nodes', this.prefix + 'buffer:' + sample.id,
    body, `${sample.t}`, sample.id, `${minute}`])
    return Number(result)
  }
  async samples(): Promise<ResourceSample[]> {
    const ids: string[] = await this.redis.sendCommand(['ZRANGE', this.prefix + 'nodes', '0', `${COMPONENT_LIMIT - 1}`])
    if (!ids.length) return []
    const values = await this.redis.sendCommand(['MGET', ...ids.map(id => this.prefix + 'latest:' + id)])
    return values.filter(Boolean).map((value: string) => JSON.parse(value))
  }
  async buffer(id: string): Promise<ResourceSample[]> {
    const values: string[] = await this.redis.sendCommand(['ZRANGE', this.prefix + 'buffer:' + id, '0', `${BUFFER_LIMIT - 1}`])
    return values.map(value => JSON.parse(value))
  }
  async acknowledged(id: string, through: number) {
    await this.redis.sendCommand(['ZREMRANGEBYSCORE', this.prefix + 'buffer:' + id, '-inf', `${through - 5 * 60000}`])
  }
  async latest(sample: ResourceSample) {
    await this.redis.sendCommand(['SET', this.prefix + 'latest:' + sample.id, JSON.stringify(sample), 'EX', '604800'])
  }
  async lease(token: string) {
    return !!await this.redis.sendCommand(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('PEXPIRE',KEYS[1],300000); return 1 end; if not redis.call('GET',KEYS[1]) then redis.call('SET',KEYS[1],ARGV[1],'PX',300000); return 1 end; return 0", '1', this.prefix + 'collector', token])
  }
  async leased(token: string) { return await this.redis.sendCommand(['GET', this.prefix + 'collector']) === token }
}

/** One configured VoIP endpoint: an old container is history, not a second service. */
export function currentResourceComponents(samples: ResourceSample[]): ResourceSample[] {
  const voip = samples.filter(s => s.kind === 'voip').reduce<ResourceSample | undefined>((latest, s) => !latest || s.t > latest.t ? s : latest, undefined)
  return samples.filter(s => s.kind !== 'voip' || s.id === voip?.id)
}

export function resourceTotal(samples: ResourceSample[]): ResourceSample {
  samples = currentResourceComponents(samples)
  const live = samples.filter(s => s.kind !== 'total' && Date.now() - s.t < LIVE_MS)
  const unavailable = samples.some(s => s.kind !== 'total' && Date.now() - s.t >= LIVE_MS)
  const groups = new Map<string, number>()
  for (const sample of live) if (sample.ramBytes !== undefined) groups.set(sample.memoryGroup || sample.id, Math.max(groups.get(sample.memoryGroup || sample.id) || 0, sample.ramBytes))
  const value = [...groups.values()].reduce((sum, bytes) => sum + bytes, 0)
  const cpuGroups = new Map<string, number>()
  for (const sample of live) if (sample.cpuPercent !== undefined) cpuGroups.set(sample.cpuGroup || sample.id, Math.max(cpuGroups.get(sample.cpuGroup || sample.id) || 0, sample.cpuPercent))
  const cpuPercent = cpuGroups.size ? Math.round([...cpuGroups.values()].reduce((sum, percent) => sum + percent, 0) * 100) / 100 : undefined
  return { id: '000000000000000000000000', name: 'Total dos serviços', kind: 'total', t: Date.now(), n: 1,
    cpuPercent, cpuMaxPercent: cpuPercent, cpuSource: 'sum', cpuPartial: unavailable || live.some(s => s.cpuPercent === undefined || s.cpuPartial),
    memorySource: 'process-rss', ramBytes: live.length ? value : undefined, ramMaxBytes: live.length ? value : undefined,
    partial: unavailable || live.some(s => s.ramBytes === undefined) }
}
