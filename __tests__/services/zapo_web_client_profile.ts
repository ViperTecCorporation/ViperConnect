import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { proto } from 'zapo-js'
import {
  installScopedZapoPayloadOverride,
  normalizeZapoWebClientProfile,
  zapoWebClientDeviceOptions,
} from '../../src/services/zapo/zapo_web_client_profile'

const payload = () => proto.ClientPayload.encode({
  userAgent: {
    platform: proto.ClientPayload.UserAgent.Platform.WEB,
    device: 'Desktop',
    appVersion: { primary: 2, secondary: 3000, tertiary: 1 },
  },
  webInfo: { webSubPlatform: proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER },
}).finish()

describe('Zapo web client profile', () => {
  test('upstream SDK resolves Business IPAD to iPad without changing personal Tablet', () => {
    const sdk = require(path.join(path.dirname(require.resolve('zapo-js')), 'transport/noise/WaClientPayload.js'))
    expect(sdk.resolveDevicePropsPlatformType(zapoWebClientDeviceOptions('wa_business').deviceBrowser)).toBe(proto.DeviceProps.PlatformType.IPAD)
    expect(sdk.resolveDevicePropsPlatformType(zapoWebClientDeviceOptions('wa_personal').deviceBrowser)).toBe(proto.DeviceProps.PlatformType.ANDROID_TABLET)
  })
  test.each([
    [undefined, 'default'],
    ['default', 'default'],
    ['wa_personal', 'wa_personal'],
    ['wa_business', 'wa_business'],
  ])('normalizes %p to %s', (input, expected) => {
    expect(normalizeZapoWebClientProfile(input)).toBe(expected)
  })

  test('rejects unknown persisted or API values', () => {
    expect(() => normalizeZapoWebClientProfile('android')).toThrow('zapo_web_client_profile_invalid')
  })

  test('preserves personal QR options and restores the e QR marker for Business', () => {
    expect(zapoWebClientDeviceOptions('default')).toEqual({})
    expect(zapoWebClientDeviceOptions('wa_personal')).toEqual({ deviceBrowser: 'android tablet', devicePlatform: 'e' })
    expect(zapoWebClientDeviceOptions('wa_business')).toEqual({ deviceBrowser: 'IPAD', devicePlatform: 'e' })
  })

  test('Business keeps SMB_IOS and WebInfo without changing upstream companion DeviceProps or pairing keys', () => {
    const context = new AsyncLocalStorage<'ANDROID' | 'SMB_IOS'>()
    const originalPayload = proto.ClientPayload.decode(payload())
    originalPayload.devicePairingData = {
      eIdent: Uint8Array.from([1, 2, 3]),
      buildHash: Uint8Array.from([4, 5]),
      deviceProps: proto.DeviceProps.encode({
        platformType: proto.DeviceProps.PlatformType.ANDROID_TABLET,
        os: 'test', requireFullSync: true,
        historySyncConfig: { supportCallLogHistory: true },
      }).finish(),
    }
    const encoded = proto.ClientPayload.encode(originalPayload).finish()
    const builders = { buildRegistrationPayload: (_config?: unknown) => encoded, buildLoginPayload: (_config?: unknown) => encoded }
    const restore = installScopedZapoPayloadOverride(builders, context)
    try {
      for (const name of ['buildRegistrationPayload', 'buildLoginPayload'] as const) {
        const business = proto.ClientPayload.decode(builders[name]({ deviceBrowser: 'IPAD' }))
        expect(business.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.SMB_IOS)
        expect(business.userAgent?.appVersion).toEqual(originalPayload.userAgent?.appVersion)
        expect(business.webInfo).toEqual(originalPayload.webInfo)
        expect(Array.from(business.devicePairingData!.eIdent!)).toEqual(Array.from(originalPayload.devicePairingData.eIdent!))
        expect(Array.from(business.devicePairingData!.buildHash!)).toEqual(Array.from(originalPayload.devicePairingData.buildHash!))
        const props = proto.DeviceProps.decode(business.devicePairingData!.deviceProps!)
        expect(props.platformType).toBe(proto.DeviceProps.PlatformType.ANDROID_TABLET)
        expect(Array.from(business.devicePairingData!.deviceProps!)).toEqual(Array.from(originalPayload.devicePairingData.deviceProps!))
        expect(business.userAgent?.device).toBe('Desktop')
        expect(props.requireFullSync).toBe(true)
        expect(props.historySyncConfig?.supportCallLogHistory).toBe(true)
        const personal = proto.ClientPayload.decode(builders[name]({ deviceBrowser: 'android tablet' }))
        expect(proto.DeviceProps.decode(personal.devicePairingData!.deviceProps!).platformType).toBe(proto.DeviceProps.PlatformType.ANDROID_TABLET)
        expect(builders[name]({ deviceBrowser: 'chrome' })).toBe(encoded)
      }
    } finally { restore() }
  })

  test('Business supplies absent WebInfo on login while personal preserves it absent', () => {
    const context = new AsyncLocalStorage<'ANDROID' | 'SMB_IOS'>()
    const encoded = proto.ClientPayload.encode({ userAgent: { platform: proto.ClientPayload.UserAgent.Platform.WEB } }).finish()
    const builders = { buildRegistrationPayload: () => encoded, buildLoginPayload: () => encoded }
    const restore = installScopedZapoPayloadOverride(builders, context)
    try {
      const business = proto.ClientPayload.decode(context.run('SMB_IOS', () => builders.buildLoginPayload()))
      expect(business.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER)
      expect(business.devicePairingData).toBeNull()
      const personal = proto.ClientPayload.decode(context.run('ANDROID', () => builders.buildLoginPayload()))
      expect(personal.webInfo).toBeNull()
    } finally { restore() }
  })

  test('isolates personal, business and default payloads in concurrent async contexts', async () => {
    const context = new AsyncLocalStorage<'ANDROID' | 'SMB_IOS'>()
    const original = jest.fn(payload)
    const builders = { buildRegistrationPayload: original, buildLoginPayload: original }
    const restore = installScopedZapoPayloadOverride(builders, context)
    try {
      const read = async (platform?: 'ANDROID' | 'SMB_IOS') => {
        const execute = async () => {
          await new Promise(resolve => setImmediate(resolve))
          return proto.ClientPayload.decode(builders.buildRegistrationPayload()).userAgent?.platform
        }
        return platform ? context.run(platform, execute) : execute()
      }
      const [personal, business, currentDefault] = await Promise.all([read('ANDROID'), read('SMB_IOS'), read()])
      expect(personal).toBe(proto.ClientPayload.UserAgent.Platform.ANDROID)
      expect(business).toBe(proto.ClientPayload.UserAgent.Platform.SMB_IOS)
      expect(currentDefault).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
    } finally {
      restore()
    }
    expect(builders.buildRegistrationPayload).toBe(original)
  })

  test('recovers the profile from the normalized client identity after connect context ends', () => {
    const context = new AsyncLocalStorage<'ANDROID' | 'SMB_IOS'>()
    const original = jest.fn(payload)
    const builders = { buildRegistrationPayload: original, buildLoginPayload: original }
    const restore = installScopedZapoPayloadOverride(builders, context)
    try {
      const personal = proto.ClientPayload.decode(builders.buildRegistrationPayload({ deviceBrowser: 'android tablet' })).userAgent?.platform
      const business = proto.ClientPayload.decode(builders.buildRegistrationPayload({ deviceBrowser: 'IPAD' })).userAgent?.platform
      const currentDefault = proto.ClientPayload.decode(builders.buildRegistrationPayload({ deviceBrowser: 'chrome' })).userAgent?.platform
      expect(personal).toBe(proto.ClientPayload.UserAgent.Platform.ANDROID)
      expect(business).toBe(proto.ClientPayload.UserAgent.Platform.SMB_IOS)
      expect(currentDefault).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
    } finally {
      restore()
    }
  })
})
