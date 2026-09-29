import { randomUUID } from 'node:crypto'
import { MobileDeviceError } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import logger from '../logger'
import { historyErrorDiagnostic } from './companion_history_prepare'

export const historyKey = (device: string) => `mobile-primary:{v1}:companion-history:${device}`
export const HISTORY_CAS = `if (redis.call('GET',KEYS[1]) or '') ~= ARGV[1] then return 0 end
if #KEYS > 1 and redis.call('GET',KEYS[2]) ~= ARGV[3] then return 0 end
redis.call('SET',KEYS[1],ARGV[2],'EX',3600) return 1`
interface Redis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export interface HistoryJob { id: string; target: string; state: 'queued' | 'running' | 'submitted' | 'empty' | 'unknown' | 'failed' | 'expired'; createdAt: number; sent: number; total: number }
export interface HistoryRuntime {
  fence: { key: string; token: string }
  current(): Promise<boolean>
  linked(target: string): Promise<boolean>
  packets(): Promise<{ message: any; count: number }[]> | AsyncIterable<{ message: any; count: number }>
  send(target: string, message: any, id: string): Promise<unknown>
}
/** One encrypted job per principal, including progress. AMQP only carries IDs.
 * A claimed job is NEVER replayed automatically after a crash/ambiguous send. */
export class CompanionHistory {
  private key: string
  constructor(private redis: Redis, private vault: RegistrationVault, private device: string) {
    if (!/^[a-f0-9-]{36}$/.test(device)) throw new MobileDeviceError(400, 'mobile_companion_scope_invalid')
    this.key = historyKey(device)
  }
  private async replace(raw: string, job: HistoryJob, fence?: HistoryRuntime['fence']) {
    const next = this.vault.seal(this.key, job)
    const ok = await this.redis.eval(HISTORY_CAS, { keys: [this.key, ...(fence ? [fence.key] : [])], arguments: [raw, next, fence?.token || ''] })
    return Number(ok) === 1 ? next : undefined
  }
  async submit(body: any, publish: (payload: { device: string; job: string }) => Promise<unknown>) {
    if (body?.confirm !== true || typeof body.target !== 'string' || !/^\d+:\d+@s\.whatsapp\.net$/.test(body.target) || Object.keys(body).some(k => !['confirm', 'target'].includes(k))) throw new MobileDeviceError(400, 'mobile_history_request_invalid')
    const raw = await this.redis.get(this.key) || ''
    const previous = raw ? this.vault.open<HistoryJob>(this.key, raw) : undefined
    if (previous && ['queued', 'running'].includes(previous.state) && Date.now() - previous.createdAt < 300000) throw new MobileDeviceError(409, 'mobile_history_busy')
    const job: HistoryJob = { id: randomUUID(), target: body.target, state: 'queued', createdAt: Date.now(), sent: 0, total: 0 }
    if (!await this.replace(raw, job)) throw new MobileDeviceError(409, 'mobile_history_busy')
    // An uncertain AMQP confirm may still have delivered: leave queued, never roll back a running job.
    try { await publish({ device: this.device, job: job.id }) } catch { throw new MobileDeviceError(503, 'mobile_history_publication_uncertain') }
    return { id: job.id, state: job.state }
  }
  async status(id: string) {
    const raw = await this.redis.get(this.key)
    const job = raw ? this.vault.open<HistoryJob>(this.key, raw) : undefined
    if (!job || job.id !== id) throw new MobileDeviceError(404, 'mobile_history_not_found')
    const state = Date.now() - job.createdAt > 300000 && ['queued', 'running'].includes(job.state) ? job.state === 'running' ? 'unknown' : 'expired' : job.state
    return { id: job.id, state, sent: job.sent, total: job.total }
  }
  async consume(id: string, runtime?: HistoryRuntime) {
    let raw: string | null | undefined = await this.redis.get(this.key)
    if (!raw) return
    const job = this.vault.open<HistoryJob>(this.key, raw)
    if (job.id !== id || job.state !== 'queued') return
    if (Date.now() - job.createdAt > 60000 || !runtime) { await this.replace(raw, { ...job, state: 'expired' }); return }
    if (!await runtime.current()) { await this.replace(raw, { ...job, state: 'failed' }); return }
    job.state = 'running'
    raw = await this.replace(raw, job, runtime.fence)
    if (!raw) return
    let sending = false
    logger.info({ jobId: job.id }, 'MOBILE_COMPANION_HISTORY_STARTED')
    try {
      if (!await runtime.linked(job.target)) throw new Error('not_linked')
      const packets = await runtime.packets()
      let index = 0
      for await (const packet of packets) {
        if (!await runtime.current() || !await runtime.linked(job.target)) throw new Error('history_interrupted')
        job.total += packet.count
        const saved = await this.replace(raw, job, runtime.fence)
        if (!saved) return
        raw = saved; sending = true
        await runtime.send(job.target, packet.message, `UH${job.id.replace(/-/g, '')}${index++}`)
        logger.info({ jobId: job.id, packet: index - 1, count: packet.count,
          syncType: packet.message.historySyncNotification?.syncType,
          chunkOrder: packet.message.historySyncNotification?.chunkOrder,
          progress: packet.message.historySyncNotification?.progress }, 'MOBILE_COMPANION_HISTORY_PACKET_SUBMITTED')
        job.sent += packet.count; sending = false
      }
      job.state = job.total ? 'submitted' : 'empty'
    } catch (error) {
      job.state = sending || job.sent > 0 ? 'unknown' : 'failed'
      logger.warn({ jobId: job.id, stage: sending ? 'send' : 'collect', sent: job.sent, ...historyErrorDiagnostic(error) }, 'MOBILE_COMPANION_HISTORY_ERROR')
    }
    const persisted = !!await this.replace(raw, job, runtime.fence)
    logger.info({ jobId: job.id, state: job.state, sent: job.sent, total: job.total, persisted }, 'MOBILE_COMPANION_HISTORY_FINISHED')
  }
}
