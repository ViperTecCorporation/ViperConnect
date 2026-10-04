import { randomBytes } from 'node:crypto'
import { X25519, xeddsaSign } from 'zapo-js/crypto'
import { convertWhalibmobCredentials } from '../../src/services/mobile_primary/whalibmob_credentials'
import { bytes, integer, keyPair, record, text } from '../../src/services/mobile_primary/credential_validation'

async function fixture() {
  const pair = async () => {
    const p = await X25519.generateKeyPair()
    return { private: Buffer.from(p.privKey), public: Buffer.concat([Buffer.from([5]), p.pubKey]) }
  }
  const identityKeyPair = await pair()
  const signed = await pair()
  return {
    phoneNumber: '999123456789', registered: true, codePending: false,
    noiseKeyPair: await pair(), identityKeyPair,
    signedPreKey: { ...signed, id: 17, signature: Buffer.from(await xeddsaSign(identityKeyPair.private, signed.public)) },
    registrationId: 100, name: 'Laboratório', version: '2.26.27.70', advIdentity: null,
    device: { os: 'android', business: false, manufacturer: 'Samsung', model: 'Galaxy', modelId: 'SM-S928B', osVersion: '14', osBuildNumber: 'UP1A' },
  }
}
const options = () => ({ expectedCanonicalPhone: '999123456789', advSecretKey: randomBytes(32) })

describe('offline whalibmob credential conversion', () => {
  test('preserves registered keys, IDs and stable secret without sharing input buffers', async () => {
    const source = await fixture()
    const opts = options()
    const result = await convertWhalibmobCredentials(source, opts)
    expect(result.meJid).toBe('999123456789@s.whatsapp.net')
    expect(Buffer.from(result.noiseKeyPair.pubKey)).toEqual(source.noiseKeyPair.public.subarray(1))
    expect(result.signedPreKey.keyId).toBe(17)
    expect(result.registrationInfo.registrationId).toBe(100)
    expect(result.deviceInfo?.business).toBe(false)
    expect(result.advSecretKey).toEqual(opts.advSecretKey)
    expect(await convertWhalibmobCredentials(source, opts)).toEqual(result)
    source.noiseKeyPair.private.fill(0)
    opts.advSecretKey.fill(0)
    expect(Buffer.from(result.noiseKeyPair.privKey).equals(source.noiseKeyPair.private)).toBe(false)
    expect(Buffer.from(result.advSecretKey).equals(opts.advSecretKey)).toBe(false)
  })
  test('accepts the base64 JSON shape and preserves iOS Business', async () => {
    const source: any = await fixture()
    source.device.os = 'ios'; source.device.business = true
    for (const pair of [source.noiseKeyPair, source.identityKeyPair, source.signedPreKey]) {
      pair.private = pair.private.toString('base64'); pair.public = pair.public.toString('base64')
    }
    source.signedPreKey.signature = source.signedPreKey.signature.toString('base64')
    const result = await convertWhalibmobCredentials(source, options())
    expect(result.deviceInfo).toMatchObject({ os: 'ios', business: true, device: 'Galaxy' })
  })
  test.each([
    ['registered', false], ['codePending', true], ['phoneNumber', '5511000000000'],
    ['registrationId', 0], ['registrationId', 16385], ['version', '2.3'],
    ['advIdentity', 'private-content'], ['name', 'bad\nname'], ['device', null],
    ['me', { id: 'companion' }],
  ])('rejects invalid %s without leaking input', async (field, value) => {
    const source: any = await fixture(); source[field] = value
    await expect(convertWhalibmobCredentials(source, options())).rejects.toThrow(/^mobile_credentials_invalid:/)
  })
  test.each(['noiseKeyPair', 'identityKeyPair', 'signedPreKey'])('rejects mismatched %s', async field => {
    const source: any = await fixture(); source[field].public[5] ^= 1
    await expect(convertWhalibmobCredentials(source, options())).rejects.toThrow(`mobile_credentials_invalid:${field}`)
  })
  test('rejects tampered signature', async () => {
    const source = await fixture(); source.signedPreKey.signature[0] ^= 1
    await expect(convertWhalibmobCredentials(source, options())).rejects.toThrow('signedPreKey.signature')
  })
  test.each([undefined, new Uint8Array(31)])('never invents a missing ADV secret', async secret => {
    await expect(convertWhalibmobCredentials(await fixture(), { ...options(), advSecretKey: secret as any })).rejects.toThrow('advSecretKey')
  })
  test.each([['os', 'web'], ['business', 'true'], ['manufacturer', ''], ['modelId', '']])('validates device %s', async (key, value) => {
    const source: any = await fixture(); source.device[key] = value
    await expect(convertWhalibmobCredentials(source, options())).rejects.toThrow('device.')
  })
})

describe('credential validators', () => {
  test('record rejects primitive and array', () => {
    for (const input of [null, [], 42, 'secret']) expect(() => record(input, 'record')).toThrow('mobile_credentials_invalid:record')
    expect(record({}, 'record')).toEqual({})
  })
  test('text rejects excessive length and controls', () => {
    for (const input of ['', 'x'.repeat(101), '\n', 42]) expect(() => text(input, 'text')).toThrow()
    expect(text('normal', 'text')).toBe('normal')
  })
  test('integer bounds are strict', () => {
    for (const input of [0, -1, 1.2, 4, '2', NaN]) expect(() => integer(input, 'id', 3)).toThrow()
    expect(integer(3, 'id', 3)).toBe(3)
  })
  test('bytes rejects permissively decoded base64 and invalid length', () => {
    for (const input of ['@@', 'YQ', 'YR==', 'YQ==', {}, new Uint8Array(2)]) expect(() => bytes(input, 'key', 32)).toThrow()
    expect(bytes(Buffer.alloc(32).toString('base64'), 'key', 32)).toHaveLength(32)
  })
  test('keyPair rejects wrong prefix and raw public key', async () => {
    const source = await fixture()
    source.noiseKeyPair.public[0] = 4
    expect(() => keyPair(source.noiseKeyPair, 'pair')).toThrow()
    source.noiseKeyPair.public = source.noiseKeyPair.public.subarray(1)
    expect(() => keyPair(source.noiseKeyPair, 'pair')).toThrow()
  })
})
