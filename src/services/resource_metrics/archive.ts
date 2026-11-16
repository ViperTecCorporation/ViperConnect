import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { STORAGE_OPTIONS } from '../../defaults'
import { ResourceIndex, ResourcePoint, ResourceSample, aggregatePoints, pointOf, validId } from './types'

export interface MetricsObjects {
  get(key: string): Promise<any | undefined>
  put(key: string, value: unknown): Promise<void>
  indexes(): Promise<string[]>
}

export function createMetricsObjects(stack: string): MetricsObjects | undefined {
  const options = STORAGE_OPTIONS(undefined)
  if (!options.bucket || !options.credentials?.secretAccessKey) return undefined
  const client = new S3Client({ ...options, maxAttempts: 1, requestHandler: new NodeHttpHandler({ connectionTimeout: 2000, socketTimeout: 5000 }) })
  const prefix = `metrics/v1/${stack}/`
  const checked = (key: string) => {
    if (!/^(?:index\/[a-f0-9]{24}|[a-f0-9]{24}\/(?:hours\/\d{4}-\d{2}-\d{2}T\d{2}|days\/\d{4}-\d{2}-\d{2}|months\/\d{4}-\d{2}))\.json$/.test(key)) throw new Error('resource_metrics_object_scope_invalid')
    return prefix + key
  }
  return {
    async get(key) {
      let body: any
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: checked(key) }), { abortSignal: AbortSignal.timeout(7000) })
        body = result.Body; const chunks: Buffer[] = []; let bytes = 0
        for await (const part of body) {
          bytes += part.length; if (bytes > 1024 * 1024) throw new Error('resource_metrics_archive_too_large')
          chunks.push(Buffer.from(part))
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error: any) { if (error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey') return undefined; throw error }
      finally { body?.destroy?.() }
    },
    async put(key, value) {
      const body = JSON.stringify(value)
      if (body.length > 1024 * 1024) throw new Error('resource_metrics_archive_too_large')
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: checked(key), Body: body, ContentType: 'application/json' }), { abortSignal: AbortSignal.timeout(7000) })
    },
    async indexes() {
      const value = await client.send(new ListObjectsV2Command({ Bucket: options.bucket, Prefix: prefix + 'index/', MaxKeys: 128 }), { abortSignal: AbortSignal.timeout(7000) })
      if (value.IsTruncated) throw new Error('resource_metrics_component_limit')
      return (value.Contents || []).map(item => item.Key?.slice((prefix + 'index/').length).replace(/\.json$/, '') || '').filter(validId)
    },
  }
}

const replacePoint = (points: ResourcePoint[], point: ResourcePoint) => [...points.filter(p => p.t !== point.t), point].sort((a, b) => a.t - b.t)
export class ResourceArchive {
  constructor(readonly objects?: MetricsObjects) {}
  async index(id: string): Promise<ResourceIndex | undefined> { return this.objects?.get(`index/${id}.json`) }
  async save(samples: ResourceSample[]) {
    if (!this.objects || !samples.length) return
    samples = [...samples].sort((a, b) => a.t - b.t)
    const latest = samples.at(-1)!, id = latest.id
    const groups = new Map<string, ResourcePoint[]>()
    for (const sample of samples) {
      const key = new Date(sample.t).toISOString().slice(0, 13)
      groups.set(key, replacePoint(groups.get(key) || [], { ...pointOf(sample), t: Math.floor(sample.t / 60000) * 60000 }))
    }
    let index: ResourceIndex = await this.index(id) || { schema: 1, sample: latest, points: [] }
    const firstAt = Math.min(index.firstAt ?? index.points[0]?.t ?? samples[0].t, samples[0].t)
    for (const [hour, incoming] of groups) {
      const hourKey = `${id}/hours/${hour}.json`, oldHour = await this.objects.get(hourKey)
      let points: ResourcePoint[] = oldHour?.points || []
      for (const point of incoming) points = replacePoint(points, point)
      await this.objects.put(hourKey, { schema: 1, points })
      const day = hour.slice(0, 10), dayKey = `${id}/days/${day}.json`, oldDay = await this.objects.get(dayKey)
      const hours = replacePoint(oldDay?.points || [], aggregatePoints(points, Date.parse(hour + ':00:00Z')))
      await this.objects.put(dayKey, { schema: 1, points: hours })
      const month = day.slice(0, 7), monthKey = `${id}/months/${month}.json`, oldMonth = await this.objects.get(monthKey)
      const days = replacePoint(oldMonth?.points || [], aggregatePoints(hours, Date.parse(day + 'T00:00:00Z')))
      await this.objects.put(monthKey, { schema: 1, points: days })
      index = { schema: 1, firstAt, sample: { ...latest, archiveState: 'ready', archivedAt: Date.now() },
        points: replacePoint(index.points, aggregatePoints(days, Date.parse(month + '-01T00:00:00Z'))) }
    }
    await this.objects.put(`index/${id}.json`, index)
  }
}
