import fetch from 'node-fetch'
import { Config } from './config'
import logger from './logger'

export type VoipCallEvent =
  | 'incoming_call'
  | 'call_ringing'
  | 'call_accepted'
  | 'call_rejected'
  | 'call_ended'
  | 'call_timeout'
  | 'call_error'

export interface VoipCallEventPayload {
  session: string
  event: VoipCallEvent
  callId: string
  from: string
  callerPn?: string
  isGroup?: boolean
  groupJid?: string
  isVideo?: boolean
  timestamp?: number
  raw?: unknown
}

export interface VoipSignalingPayload {
  session: string
  callId: string
  peerJid: string
  payload?: string
  payloadBase64?: string
  rawCallRootWapBase64?: string
  rawCallOfferRootMinimalWapBase64?: string
  rawCallOfferRootEnrichedWapBase64?: string
  rawCallOfferRootPrunedWapBase64?: string
  rawCallOfferRootNoEncoptWapBase64?: string
  rawCallOfferRootNoMetadataWapBase64?: string
  rawCallOfferRootNoEncoptNoMetadataWapBase64?: string
  rawCallOfferRootNoRelayWapBase64?: string
  rawCallOfferRootNoNetWapBase64?: string
  rawCallOfferRootNoRteWapBase64?: string
  rawCallOfferRootCoreRelayWapBase64?: string
  rawCallOfferRootCallerMetadataWapBase64?: string
  rawCallOfferRootCreatorDeviceWapBase64?: string
  rawCallOfferRootCallerMetadataCreatorDeviceWapBase64?: string
  rawCallOfferRootNoJoinableWapBase64?: string
  rawCallOfferRootNoCallerPnWapBase64?: string
  rawCallOfferRootNoCountryCodeWapBase64?: string
  rawCallOfferRootMinimalAttrsWapBase64?: string
  rawCallOfferEncWapBase64?: string
  rawOfferEncBase64?: string
  rawDecryptedCallFrameBase64?: string
  rawOfferWapNoPrefixBase64?: string
  rawOfferChildWapBase64?: string
  tcTokenBase64?: string
  payloadEncoding?: 'xml' | 'wa_binary'
  attrs?: Record<string, string>
  outerAttrs?: Record<string, string>
  encAttrs?: Record<string, string>
  msgType?: string
  timestamp?: number
}

export type VoipCommand =
  | {
      action: 'send_call_node'
      session: string
      callId: string
      peerJid: string
      payloadBase64: string
      payloadTag?: string
      payloadChildTag?: string
    }
  | {
      action: 'voip_event'
      session: string
      callId: string
      eventType: number
      eventData?: string
    }
  | {
      action: 'noop'
      session: string
      callId: string
      reason: string
    }

export const mapBaileysCallStatusToVoipEvent = (status: unknown): VoipCallEvent | undefined => {
  const normalized = `${status || ''}`.trim().toLowerCase()
  if (!normalized) return undefined
  if (['ringing', 'offer'].includes(normalized)) return 'incoming_call'
  if (['accepted', 'accept', 'connected', 'connect'].includes(normalized)) return 'call_accepted'
  if (['rejected', 'reject', 'declined', 'decline'].includes(normalized)) return 'call_rejected'
  if (['ended', 'end', 'terminated', 'terminate', 'hangup', 'hang_up'].includes(normalized)) return 'call_ended'
  if (['timeout', 'timed_out', 'missed'].includes(normalized)) return 'call_timeout'
  if (['error', 'failed', 'fail'].includes(normalized)) return 'call_error'
  return undefined
}

export const sendVoipCallEvent = async (
  config: Config,
  payload: VoipCallEventPayload,
): Promise<{ ok: boolean; status?: number; body?: unknown; reason?: string }> => {
  const baseUrl = `${config.voipServiceUrl || ''}`.trim().replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, reason: 'disabled' }

  const url = `${baseUrl}/v1/calls/events`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (config.voipServiceToken) headers.Authorization = `Bearer ${config.voipServiceToken}`
  const startedAt = Date.now()

  try {
    logger.info(
      {
        url,
        timeoutMs: config.voipServiceTimeoutMs || 10_000,
        session: payload.session,
        callId: payload.callId,
        event: payload.event,
      },
      'sending voip call event'
    )
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.voipServiceTimeoutMs || 10_000),
    })
    let body: unknown = undefined
    try {
      body = await response.json()
    } catch {}
    if (!response.ok) {
      logger.warn(
        { url, status: response.status, session: payload.session, callId: payload.callId, event: payload.event, body },
        'voip service call event request failed'
      )
      return { ok: false, status: response.status, body }
    }
    logger.info(
      {
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        session: payload.session,
        callId: payload.callId,
        event: payload.event,
      },
      'voip call event sent'
    )
    return { ok: true, status: response.status, body }
  } catch (error) {
    logger.warn(
      {
        err: error,
        url,
        durationMs: Date.now() - startedAt,
        timeoutMs: config.voipServiceTimeoutMs || 10_000,
        session: payload.session,
        callId: payload.callId,
        event: payload.event,
      },
      'failed to send voip call event'
    )
    return { ok: false, reason: 'request_failed' }
  }
}

export const sendVoipSignaling = async (
  config: Config,
  payload: VoipSignalingPayload,
): Promise<{ ok: boolean; status?: number; body?: unknown; reason?: string }> => {
  const baseUrl = `${config.voipServiceUrl || ''}`.trim().replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, reason: 'disabled' }

  const url = `${baseUrl}/v1/calls/signaling`
  const timeoutMs = Math.max(config.voipServiceTimeoutMs || 10_000, 30_000)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (config.voipServiceToken) headers.Authorization = `Bearer ${config.voipServiceToken}`
  const startedAt = Date.now()

  try {
    logger.info(
      {
        url,
        timeoutMs,
        session: payload.session,
        callId: payload.callId,
        peerJid: payload.peerJid,
        msgType: payload.msgType || 'unknown',
      },
      'sending voip signaling'
    )
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body: unknown = undefined
    try {
      body = await response.json()
    } catch {}
    if (!response.ok) {
      logger.warn(
        { url, status: response.status, session: payload.session, callId: payload.callId, msgType: payload.msgType, body },
        'voip service signaling request failed'
      )
      return { ok: false, status: response.status, body }
    }
    logger.info(
      {
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        session: payload.session,
        callId: payload.callId,
        peerJid: payload.peerJid,
        msgType: payload.msgType || 'unknown',
      },
      'voip signaling sent'
    )
    return { ok: true, status: response.status, body }
  } catch (error) {
    logger.warn(
      {
        err: error,
        url,
        durationMs: Date.now() - startedAt,
        timeoutMs,
        session: payload.session,
        callId: payload.callId,
        peerJid: payload.peerJid,
        msgType: payload.msgType || 'unknown',
      },
      'failed to send voip signaling'
    )
    return { ok: false, reason: 'request_failed' }
  }
}

export const drainVoipCommands = async (
  config: Config,
  session: string,
  callId: string,
): Promise<{ ok: boolean; status?: number; body?: unknown; reason?: string }> => {
  const baseUrl = `${config.voipServiceUrl || ''}`.trim().replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, reason: 'disabled' }

  const url = `${baseUrl}/v1/calls/sessions/${encodeURIComponent(session)}/calls/${encodeURIComponent(callId)}/commands/drain`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (config.voipServiceToken) headers.Authorization = `Bearer ${config.voipServiceToken}`
  const startedAt = Date.now()

  try {
    logger.info(
      {
        url,
        timeoutMs: config.voipServiceTimeoutMs || 10_000,
        session,
        callId,
      },
      'draining voip async commands'
    )
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(config.voipServiceTimeoutMs || 10_000),
    })
    let body: unknown = undefined
    try {
      body = await response.json()
    } catch {}
    if (!response.ok) {
      logger.warn(
        { url, status: response.status, session, callId, body },
        'voip service async command drain failed'
      )
      return { ok: false, status: response.status, body }
    }
    logger.info(
      {
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        session,
        callId,
      },
      'voip async commands drained'
    )
    return { ok: true, status: response.status, body }
  } catch (error) {
    logger.warn(
      {
        err: error,
        url,
        durationMs: Date.now() - startedAt,
        timeoutMs: config.voipServiceTimeoutMs || 10_000,
        session,
        callId,
      },
      'failed to drain voip async commands'
    )
    return { ok: false, reason: 'request_failed' }
  }
}

export const extractVoipCommands = (body: unknown): VoipCommand[] => {
  if (!body || typeof body !== 'object') return []
  const commands = (body as any)?.commands
  return Array.isArray(commands) ? commands as VoipCommand[] : []
}
