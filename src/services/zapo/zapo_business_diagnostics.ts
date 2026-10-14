/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { proto } from 'zapo-js'
import logger from '../logger'

const payloadObservers = new WeakMap<object, (payload: any, stage: string) => void>()
const tags = new Set(['iq', 'success', 'failure', 'stream:error', 'notification', 'presence', 'message', 'receipt', 'ack', 'pair-success', 'pair-device-sign', 'device-identity', 'error', 'ib', 'offline', 'active', 'passive', 'ping', 'query', 'sync', 'groups', 'participating', 'account', 'prekeys', 'encrypt', 'dirty', 'remove', 'not-authorized'])
const namespaces = new Set(['w:g2', 'w:auth', 'w:sync:app:state', 'w:gp2', 'w:p', 'w:profile:picture', 'encrypt', 'md', 'usync', 'urn:xmpp:ping', 'w', 'passive', 'privacy', 'urn:xmpp:whatsapp:dirty'])
const enumName = (values: any, value: unknown) => typeof value === 'number' ? values[value] ?? 'unknown' : null
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/** Deliberately excludes stanza IDs, addresses, attributes, bytes and text. */
export const safeBusinessNodeSummary = (node: any) => ({
  tag: tags.has(node?.tag) ? node.tag : 'other',
  type: ['get', 'set', 'result', 'error', 'available', 'unavailable'].includes(node?.attrs?.type) ? node.attrs.type : null,
  namespace: namespaces.has(node?.attrs?.xmlns) ? node.attrs.xmlns : null,
  code: /^\d{3}$/.test(`${node?.attrs?.code ?? ''}`) ? Number(node.attrs.code) : null,
  reasonCode: /^\d{3}$/.test(`${node?.attrs?.reason ?? ''}`) ? Number(node.attrs.reason) : null,
  children: Array.isArray(node?.content) ? node.content.slice(0, 12).map((child: any) => tags.has(child?.tag) ? child.tag : 'other') : [],
})

export const safeBusinessPayloadSummary = (payload: any) => {
  const version = payload.userAgent?.appVersion
  const props = payload.devicePairingData?.deviceProps ? proto.DeviceProps.decode(payload.devicePairingData.deviceProps) : null
  return {
    platform: enumName(proto.ClientPayload.UserAgent.Platform, payload.userAgent?.platform),
    device: ['Desktop', 'Android', 'android'].includes(payload.userAgent?.device) ? payload.userAgent.device : 'other',
    osVersion: typeof payload.userAgent?.osVersion === 'string' && /^[0-9.]{1,20}$/.test(payload.userAgent.osVersion) ? payload.userAgent.osVersion : null,
    version: version ? [version.primary, version.secondary, version.tertiary, version.quaternary, version.quinary].map(number) : null,
    webInfoPresent: !!payload.webInfo,
    webSubPlatform: enumName(proto.ClientPayload.WebInfo.WebSubPlatform, payload.webInfo?.webSubPlatform),
    deviceProps: enumName(proto.DeviceProps.PlatformType, props?.platformType),
    fullHistory: props?.requireFullSync === true,
    registered: !!payload.username,
    passive: payload.passive === true,
    pull: payload.pull === true,
  }
}

export const observeBusinessPayload = (config: any, payload: any, stage: string) => {
  try { if (config && typeof config === 'object') payloadObservers.get(config)?.(payload, stage) } catch { /* Diagnostics never affect the handshake. */ }
}

/** Wrap only the selected instance; all provider calls retain their arguments/results. */
export const installBusinessDiagnosticFactory = (factory: any, phone: string, expiresAt: number,
  report: (record: Record<string, unknown>) => void = record => logger.info(record, 'ZAPO_BUSINESS_DIAGNOSTIC')) => {
  const original = factory.buildWaClientDependencies
  factory.buildWaClientDependencies = function (input: any) {
    const deps = original.call(this, input)
    if (input.base.options.sessionId !== phone || input.base.options.deviceBrowser !== 'IPAD' || Date.now() >= expiresAt) return deps
    let count = 0
    const emit = (stage: string, details: Record<string, unknown> = {}) => {
      if (Date.now() >= expiresAt || count >= 200) return
      try { report({ phone, stage, sequence: ++count, ...details }) } catch { /* Observational only. */ }
    }
    emit('attached', { companionPlatform: deps.authClient.options.devicePlatform === '1' ? 'CHROME' : 'other' })
    deps.nodeTransport.on('node_in', (node: any) => emit('node_in', safeBusinessNodeSummary(node)))
    deps.nodeTransport.on('node_out', (node: any) => emit('node_out', safeBusinessNodeSummary(node)))
    const auth = deps.authClient
    const buildConfig = auth.buildCommsConfig
    auth.buildCommsConfig = async function (...args: any[]) {
      const result = await buildConfig.apply(this, args)
      for (const config of [result.noise?.loginPayloadConfig, result.noise?.registrationPayloadConfig]) {
        if (config) payloadObservers.set(config, (payload, stage) => emit(stage, safeBusinessPayloadSummary(payload)))
      }
      return result
    }
    const flow = auth.pairingFlow
    const complete = flow.completePairSuccess
    flow.completePairSuccess = async function (...args: any[]) {
      const children = Array.isArray(args[1]?.content) ? args[1].content : []
      const platform = children.find((node: any) => node.tag === 'platform')?.attrs?.name
      emit('pair_success_received', { primaryPlatform: ['android', 'smb_android', 'smba', 'smbi', 'ios', 'web'].includes(platform) ? platform : 'other' })
      try {
        const identityNode = children.find((node: any) => node.tag === 'device-identity')
        const identity = proto.ADVSignedDeviceIdentityHMAC.decode(identityNode.content)
        emit('account_identity_type', { accountType: enumName(proto.ADVEncryptionType, identity.accountType) })
      } catch { /* Original provider validation remains authoritative. */ }
      try {
        const result = await complete.apply(this, args)
        emit('pair_success_completed', {
          hmacVerificationEnabled: this.opts.dangerous?.disablePairSuccessHmacVerification !== true,
          signatureVerificationEnabled: this.opts.dangerous?.disableAdvSignatureVerification !== true,
        })
        return result
      } catch (error) { emit('pair_success_failed'); throw error }
    }
    const buildIdentity = flow.buildPairSuccessResponseIdentity
    flow.buildPairSuccessResponseIdentity = async function (...args: any[]) {
      const result = await buildIdentity.apply(this, args)
      emit('account_signature_result', { accepted: !!result })
      try {
        const identity = proto.ADVSignedDeviceIdentity.decode(args[1])
        const details = proto.ADVDeviceIdentity.decode(identity.details!)
        emit('device_identity_type', { deviceType: enumName(proto.ADVEncryptionType, details.deviceType) })
      } catch { /* Do not serialize bytes or parser errors. */ }
      return result
    }
    return deps
  }
  return () => { factory.buildWaClientDependencies = original }
}

/** Disabled unless a short-lived, explicit target is configured. No credentials. */
export const installConfiguredBusinessDiagnostics = () => {
  try {
    const config = JSON.parse(readFileSync(path.join(__dirname, 'zapo_business_diagnostics.json'), 'utf8'))
    const expiresAt = Date.parse(config.expiresAt)
    if (typeof config.phone !== 'string' || !/^\d{10,15}$/.test(config.phone) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 30 * 60_000) return
    const entry = require.resolve('zapo-js')
    const factory = module.require(path.join(path.dirname(entry), 'client/WaClientFactory.js'))
    installBusinessDiagnosticFactory(factory, config.phone, expiresAt)
    logger.info({ phone: config.phone, expiresAt: new Date(expiresAt).toISOString() }, 'ZAPO_BUSINESS_DIAGNOSTIC_ENABLED')
  } catch { /* Absent or invalid activation keeps diagnostics disabled. */ }
}
