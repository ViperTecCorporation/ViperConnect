/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { proto } from 'zapo-js'
import logger from '../logger'

export type ZapoWebClientProfile = 'default' | 'wa_personal' | 'wa_business'
type ZapoUserAgentPlatform = 'ANDROID' | 'SMB_ANDROID'
type PayloadBuilderName = 'buildRegistrationPayload' | 'buildLoginPayload'
type PayloadBuilders = Record<PayloadBuilderName, (...args: any[]) => Uint8Array>

const USER_AGENT_PLATFORM: Record<Exclude<ZapoWebClientProfile, 'default'>, ZapoUserAgentPlatform> = {
  wa_personal: 'ANDROID',
  wa_business: 'SMB_ANDROID',
}

const profileContext = new AsyncLocalStorage<ZapoUserAgentPlatform>()
let runtimeOverrideInstalled = false

export const normalizeZapoWebClientProfile = (value: unknown): ZapoWebClientProfile => {
  const profile = `${value ?? 'default'}`.trim().toLowerCase()
  if (profile === 'default' || profile === 'wa_personal' || profile === 'wa_business') return profile
  throw new Error('zapo_web_client_profile_invalid')
}

export const zapoWebClientDeviceOptions = (value: unknown) => {
  const profile = normalizeZapoWebClientProfile(value)
  return profile === 'default' ? {} : {
    // Zapo normalizes both values to ANDROID_TABLET. Keeping a distinct case
    // gives the deferred Noise payload builder a per-client profile marker
    // after connect() has returned, without process-global mutable state.
    deviceBrowser: profile === 'wa_business' ? 'ANDROID TABLET' : 'android tablet',
    devicePlatform: 'e',
  }
}

const platformFromPayloadConfig = (config: any): ZapoUserAgentPlatform | undefined => {
  if (`${config?.deviceBrowser || ''}` === 'android tablet') return 'ANDROID'
  if (`${config?.deviceBrowser || ''}` === 'ANDROID TABLET') return 'SMB_ANDROID'
  return undefined
}

export const installScopedZapoPayloadOverride = (
  builders: PayloadBuilders,
  context: Pick<AsyncLocalStorage<ZapoUserAgentPlatform>, 'getStore'>,
  protocol: typeof proto = proto,
) => {
  const originals = {} as PayloadBuilders
  for (const name of ['buildRegistrationPayload', 'buildLoginPayload'] as const) {
    if (typeof builders[name] !== 'function') throw new Error('zapo_web_client_profile_unsupported_runtime')
    originals[name] = builders[name]
  }
  for (const name of Object.keys(originals) as PayloadBuilderName[]) {
    builders[name] = function (...args: any[]) {
      const encoded = originals[name].apply(this, args)
      const platform = context.getStore() ?? platformFromPayloadConfig(args[0])
      if (!platform) return encoded
      const payload = protocol.ClientPayload.decode(encoded)
      if (!payload.userAgent) throw new Error('zapo_web_client_profile_missing_user_agent')
      payload.userAgent.platform = protocol.ClientPayload.UserAgent.Platform[platform]
      logger.info('Zapo web profile payload override builder=%s user_agent=%s', name, platform)
      return protocol.ClientPayload.encode(payload).finish()
    }
  }
  return () => {
    for (const name of Object.keys(originals) as PayloadBuilderName[]) builders[name] = originals[name]
  }
}

const ensureRuntimeOverride = () => {
  if (runtimeOverrideInstalled) return
  const zapoEntry = require.resolve('zapo-js')
  const builders = module.require(path.join(path.dirname(zapoEntry), 'transport/noise/WaClientPayload.js')) as PayloadBuilders
  installScopedZapoPayloadOverride(builders, profileContext)
  runtimeOverrideInstalled = true
}

export const withZapoWebClientProfile = async <T>(value: unknown, operation: () => Promise<T>): Promise<T> => {
  const profile = normalizeZapoWebClientProfile(value)
  if (profile === 'default') return operation()
  ensureRuntimeOverride()
  return profileContext.run(USER_AGENT_PLATFORM[profile], operation)
}

export const zapoWebClientProfileLabel = (value: unknown) => {
  const profile = normalizeZapoWebClientProfile(value)
  return profile === 'wa_personal' ? 'ANDROID' : profile === 'wa_business' ? 'SMB_ANDROID' : 'WEB'
}
