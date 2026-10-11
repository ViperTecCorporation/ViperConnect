import { AsyncLocalStorage } from 'node:async_hooks'
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

  test('maps only experimental profiles to Android tablet plus e', () => {
    expect(zapoWebClientDeviceOptions('default')).toEqual({})
    expect(zapoWebClientDeviceOptions('wa_personal')).toEqual({ deviceBrowser: 'android tablet', devicePlatform: 'e' })
    expect(zapoWebClientDeviceOptions('wa_business')).toEqual({ deviceBrowser: 'ANDROID TABLET', devicePlatform: 'e' })
  })

  test('isolates personal, business and default payloads in concurrent async contexts', async () => {
    const context = new AsyncLocalStorage<'ANDROID' | 'SMB_ANDROID'>()
    const original = jest.fn(payload)
    const builders = { buildRegistrationPayload: original, buildLoginPayload: original }
    const restore = installScopedZapoPayloadOverride(builders, context)
    try {
      const read = async (platform?: 'ANDROID' | 'SMB_ANDROID') => {
        const execute = async () => {
          await new Promise(resolve => setImmediate(resolve))
          return proto.ClientPayload.decode(builders.buildRegistrationPayload()).userAgent?.platform
        }
        return platform ? context.run(platform, execute) : execute()
      }
      const [personal, business, currentDefault] = await Promise.all([read('ANDROID'), read('SMB_ANDROID'), read()])
      expect(personal).toBe(proto.ClientPayload.UserAgent.Platform.ANDROID)
      expect(business).toBe(proto.ClientPayload.UserAgent.Platform.SMB_ANDROID)
      expect(currentDefault).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
    } finally {
      restore()
    }
    expect(builders.buildRegistrationPayload).toBe(original)
  })

  test('recovers the profile from the normalized client identity after connect context ends', () => {
    const context = new AsyncLocalStorage<'ANDROID' | 'SMB_ANDROID'>()
    const original = jest.fn(payload)
    const builders = { buildRegistrationPayload: original, buildLoginPayload: original }
    const restore = installScopedZapoPayloadOverride(builders, context)
    try {
      const personal = proto.ClientPayload.decode(builders.buildRegistrationPayload({ deviceBrowser: 'android tablet' })).userAgent?.platform
      const business = proto.ClientPayload.decode(builders.buildRegistrationPayload({ deviceBrowser: 'ANDROID TABLET' })).userAgent?.platform
      const currentDefault = proto.ClientPayload.decode(builders.buildRegistrationPayload({ deviceBrowser: 'chrome' })).userAgent?.platform
      expect(personal).toBe(proto.ClientPayload.UserAgent.Platform.ANDROID)
      expect(business).toBe(proto.ClientPayload.UserAgent.Platform.SMB_ANDROID)
      expect(currentDefault).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
    } finally {
      restore()
    }
  })
})
