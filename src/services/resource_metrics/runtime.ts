import { randomUUID } from 'node:crypto'
import { createClient } from '@redis/client'
import { AMQP_URL, BASE_STORE, REDIS_URL } from '../../defaults'
import { VoipService } from '../voip_service'
import logger from '../logger'
import { ResourceArchive, createMetricsObjects } from './archive'
import { ProcessResourceSampler, normalizeVoipResourceSample, sampleRedis } from './sampler'
import { ResourceMetricsStore, resourceTotal, stackId } from './store'
import type { ResourceSample } from './types'
import { ResourceMetricsQuery } from './query'
import { CpuUsageDelta } from './cpu'
import { RabbitManagement } from '../rabbitmq_management'
import { rabbitResourceSample } from './rabbitmq'
import { RabbitCpuSampler } from './rabbitmq_cpu'
import { storageRoot } from '../session_storage/capability'

let query: ResourceMetricsQuery | undefined
export async function resourceMetricsQuery() {
  if (!query) {
    // Independent, non-queuing connection: a Redis outage must not prevent S3 reads
    // or accumulate pending telemetry commands in application memory.
    const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true,
      socket: { connectTimeout: 2000, reconnectStrategy: retries => Math.min(5000, 500 * (retries + 1)) } })
    redis.on('error', () => undefined)
    void redis.connect().catch(() => undefined)
    const store = new ResourceMetricsStore(redis, stackId())
    query = new ResourceMetricsQuery(store, new ResourceArchive(createMetricsObjects(store.stack)), new VoipService().available(), !!AMQP_URL)
  }
  return query
}

export function startResourceMetrics(role: string) {
  if (process.env.RESOURCE_METRICS_ENABLED === 'false') return
  if (process.env.NODE_ENV === 'test' && process.env.RESOURCE_METRICS_ENABLED !== 'true') return
  const sampler = new ProcessResourceSampler(role, [BASE_STORE, ...(['worker', 'all'].includes(role) ? [storageRoot()] : process.env.SESSION_STORAGE_ROOT ? [process.env.SESSION_STORAGE_ROOT] : [])])
  const redisCpu = new CpuUsageDelta()
  const rabbitCpu = new RabbitCpuSampler()
  const token = randomUUID(), states = new Map<string, { next: number; archivedAt?: number; state: 'ready' | 'error' | 'disabled'; dropped: number }>()
  let running = false
  const publish = async (sample: ResourceSample, store: ResourceMetricsStore, archive: ResourceArchive) => {
    const state = states.get(sample.id) || { next: 0, state: archive.objects ? 'ready' : 'disabled', dropped: 0 }
    sample.archiveState = state.state; sample.archivedAt = state.archivedAt; sample.droppedPoints = state.dropped
    state.dropped += await store.save(sample)
    if (archive.objects && Date.now() >= state.next) {
      state.next = Date.now() + 15 * 60000
      try {
        const buffered = await store.buffer(sample.id)
        await archive.save(buffered)
        state.archivedAt = Date.now(); state.state = 'ready'
        await store.acknowledged(sample.id, sample.t)
      } catch {
        state.state = 'error'; state.next = Date.now() + 60000
        logger.warn('RESOURCE_METRICS_ARCHIVE_UNAVAILABLE component=%s; recent buffer remains bounded', sample.id)
      }
    }
    await store.latest({ ...sample, archiveState: state.state, archivedAt: state.archivedAt, droppedPoints: state.dropped })
    states.set(sample.id, state)
  }
  const tick = async () => {
    if (running) return
    running = true
    try {
      const service = await resourceMetricsQuery(), { store, archive } = service
      await publish(await sampler.sample(), store, archive)
      if ((role === 'web' || role === 'all') && await store.lease(token)) {
        try { await publish(await sampleRedis(store.redis, store.stack, redisCpu), store, archive) } catch { logger.warn('RESOURCE_METRICS_REDIS_SAMPLE_UNAVAILABLE') }
        if (AMQP_URL) try {
          const snapshot = await new RabbitManagement().resourceSnapshot()
          const sample = { ...rabbitResourceSample(snapshot, store.stack), ...await rabbitCpu.sample(snapshot.nodes) }
          if (await store.leased(token)) await publish(sample, store, archive)
        } catch { logger.warn('RESOURCE_METRICS_RABBITMQ_SAMPLE_UNAVAILABLE; archived readings remain available') }
        const voip = new VoipService()
        if (voip.available()) try {
          const sample = normalizeVoipResourceSample(await voip.request('/v1/resources/metrics'))
          if (await store.leased(token)) await publish(sample, store, archive)
        } catch { logger.warn('RESOURCE_METRICS_VOIP_SAMPLE_UNAVAILABLE; archived readings remain available') }
        if (await store.leased(token)) await publish(resourceTotal(await store.samples()), store, archive)
      }
    } catch { logger.warn('RESOURCE_METRICS_SAMPLE_UNAVAILABLE; application continues normally') }
    finally { running = false }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, 60000); timer.unref()
  return () => clearInterval(timer)
}
