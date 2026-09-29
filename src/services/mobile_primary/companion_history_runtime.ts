import { defineWaClientPlugin } from 'zapo-js'
import { CompanionHistory, type HistoryRuntime } from './companion_history'
import { RegistrationVault } from './registration_vault'
import { companionOperations } from './companion_runtime'
import { ZAPO_REDIS_KEY_PREFIX } from '../../defaults'
import { installHistoryBootstrap } from './companion_history_bootstrap'
import { MobileDeviceError } from '../mobile_device_service'
import { streamCompanionHistory } from './companion_history_stream'
import { prepareCompanionHistory } from './companion_history_prepare'
import { keysBeforeHistory } from './companion_keys_before_history'
import { threeChunkHistory } from './companion_history_three_chunks'
import { applyHistoryStatus } from './companion_history_status'
import { waitHistorySubmission } from './companion_history_submission'
import { traceCompanionKeyShare } from './companion_key_share_trace'
import { traceCompanionHistoryRequest } from './companion_history_request_trace'
import { CompanionHistoryReceiptTrace } from './companion_history_receipt_trace'
import logger from '../logger'
import { traceCompanionOutgoing } from './companion_outgoing_trace'

export const COMPANION_HISTORY_QUEUE = 'unoapi.mobile.companion.history.mobile_lab.zapo'
const EXCHANGE = 'unoapi.mobile.companion.history'
const runtimes = new Map<string, HistoryRuntime>()
const enabled = () => process.env.UNOAPI_MOBILE_PRIMARY_LAB === 'true' && process.env.UNOAPI_SERVER_NAME === 'mobile_lab'

export async function companionHistoryService(device: string) {
  const { getRedis } = await import('../redis.js')
  return new CompanionHistory(await getRedis(), new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || ''), device)
}
export async function requestCompanionHistory(device: string, _body: unknown) {
  await companionOperations(device) // Validate registration, active configuration and lab scope.
  throw new MobileDeviceError(410, 'mobile_history_pair_time_only')
}
export async function startCompanionHistoryConsumer() {
  if (!enabled()) return
  const { amqpConsume } = await import('../../amqp.js')
  await amqpConsume(EXCHANGE, COMPANION_HISTORY_QUEUE, '', async (_key, value: any) => {
    if (!value || !/^[a-f0-9-]{36}$/.test(value.device || '') || !/^[a-f0-9-]{36}$/.test(value.job || '')) return
    await (await companionHistoryService(value.device)).consume(value.job, runtimes.get(value.device))
  }, { type: 'direct', prefetch: 1 })
}

/** Existing socket, advanced plugin context and per-instance bootstrap interception.
 * Version-sensitive: contract-tested against the installed Zapo coordinator. */
export function companionHistoryPlugin(device: string, phone: string, fence: HistoryRuntime['fence'], current: () => boolean) {
  return defineWaClientPlugin({ id: 'uno-companion-history', setup(ctx) {
    if (!enabled()) return
    // Approved history allowlist for every mobile-primary lab session.
    // Other message types remain archived and usable by normal messaging.
    const strategy = 'inline-text-video-only'
    ctx.registerDispose(traceCompanionOutgoing(ctx.deps.messageDispatch, device))
    const receiptTrace = new CompanionHistoryReceiptTrace(device)
    const removeReceiptTrace = ctx.registerIncomingHandler({ tag: 'receipt', prepend: true, handler: async node => {
      if (!current()) return false
      return receiptTrace.observe(node)
    } })
    ctx.registerDispose(removeReceiptTrace)
    // ACKs may be consumed by pending queries before registered handlers run.
    const onAck: Parameters<typeof ctx.client.on<'debug_transport_node_in'>>[1] = ({ node }) => {
      if (current() && node.tag === 'ack') receiptTrace.observe(node)
    }
    ctx.client.on('debug_transport_node_in', onAck)
    ctx.registerDispose(() => { ctx.client.off('debug_transport_node_in', onAck) })
    ctx.registerDispose(() => receiptTrace.clear())
    const stopKeyTrace = traceCompanionKeyShare(ctx.client.mobile, device)
    const earlyKeys = keysBeforeHistory(ctx.client.mobile)
    const onProtocol: Parameters<typeof ctx.client.on<'message_protocol'>>[1] = event => {
      if (current()) traceCompanionHistoryRequest(event, device)
    }
    ctx.client.on('message_protocol', onProtocol)
    ctx.registerDispose(() => { ctx.client.off('message_protocol', onProtocol) })
    const provisioned = new Set<string>()
    const runtime: HistoryRuntime = {
      fence,
      async current() {
        if (!current() || !enabled()) return false
        const { getRedis, getConfig } = await import('../redis.js')
        const redis = await getRedis(), config = await getConfig(phone)
        return current() && await redis.get(fence.key) === fence.token && config?.mobilePrimaryDraftId === device && config.autoConnect !== false && !config.mobilePrimaryDeleting && config.server === 'mobile_lab'
      },
      async linked(target) { return provisioned.has(target) && (await ctx.client.mobile.listCompanions()).some(item => item.deviceJid === target) },
      async *packets() {
        const { getRedis, getUnoId, getMessageStatus } = await import('../redis.js')
        const pages = streamCompanionHistory(ctx.stores, await getRedis(), ZAPO_REDIS_KEY_PREFIX, phone, 'text-video',
          conversations => applyHistoryStatus(conversations,
            async id => (await getUnoId(phone, id)) || undefined,
            async id => (await getMessageStatus(phone, id)) || undefined))
        for await (const packet of threeChunkHistory(pages, 192000, 'text-video-sticker-image')) {
          if (!await runtime.current()) throw new Error('mobile_history_not_connected')
          yield packet
        }
      },
      async send(target, message, _jobPacketId) {
        const id = await ctx.deps.messageDispatch.generateOutgoingMessageId()
        receiptTrace.track(id, target, message.historySyncNotification?.chunkOrder ?? 0)
        const details = { device, packet: message.historySyncNotification?.chunkOrder,
          progress: message.historySyncNotification?.progress, strategy }
        await ctx.deps.messageDispatch.publishProtocolMessageToDevice(target, message, { id })
        logger.info(details, 'MOBILE_COMPANION_HISTORY_PACKET_SERVER_ACKED')
      },
    }
    runtimes.set(device, runtime)
    const restore = installHistoryBootstrap(ctx.client.mobile, async target => {
      if (!await runtime.current()) throw new Error('mobile_history_not_connected')
      // A prekey failure before publication is safe for the SDK to retry.
      await prepareCompanionHistory(() => ctx.deps.messageDispatch.syncSignalSession(target))
      await earlyKeys.share(target)
      if (!await runtime.current()) throw new Error('mobile_history_not_connected')
      provisioned.add(target)
      const service = await companionHistoryService(device)
      const { amqpPublish } = await import('../../amqp.js')
      const job = await service.submit({ target, confirm: true }, payload => amqpPublish(EXCHANGE, COMPANION_HISTORY_QUEUE, '', payload, { type: 'direct', maxRetries: 0 }))
      logger.info({ device, jobId: job.id, strategy }, 'MOBILE_COMPANION_HISTORY_QUEUED_AFTER_KEYS')
      return waitHistorySubmission(() => service.status(job.id), () => runtime.current())
    })
    ctx.registerDispose(() => { restore(); earlyKeys.dispose(); stopKeyTrace(); provisioned.clear(); if (runtimes.get(device) === runtime) runtimes.delete(device) })
  } })
}
