import { MobileCompanionPersistence, validateCompanionEpoch, SAVE_COMPANION_EPOCH, serializeCompanionEpoch, deserializeCompanionEpoch } from '../../src/services/mobile_primary/companion_persistence'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'

const id = '00000000-0000-0000-0000-000000000001', phone = '999123456789'
const state = () => ({ rawId: 10, currentKeyIndex: 1, companions: [{ deviceJid: '999123456789:2@s.whatsapp.net', keyIndex: 1, companionIdentityPublicKey: new Uint8Array(32).fill(7), addedAtSeconds: 100 }] })
test('portable epoch serialization round-trips and rejects corrupt binary material', () => {
  expect(deserializeCompanionEpoch(serializeCompanionEpoch(state()))).toEqual(state())
  expect(() => deserializeCompanionEpoch({ rawId: 1, currentKeyIndex: 1, companions: [{ ...state().companions[0], companionIdentityPublicKey: 'bad' }] })).toThrow('state_invalid')
})
function setup() {
  let stored: string | null = null, token = 'owner'
  const redis = { get: jest.fn(async () => stored), eval: jest.fn(async (_script: string, options: any) => {
    if (options.arguments[0] !== token || options.arguments[1] !== (stored || '')) return 0
    stored = options.arguments[2]; return 1
  }) }
  const vault = new RegistrationVault('ab'.repeat(32))
  return { redis, create: () => new MobileCompanionPersistence(redis, vault, id, phone, 'owner'), loseLease: () => { token = 'another-owner' } }
}
test('encrypted epoch round-trip persists binary identity, never uses TTL', async () => {
  const f = setup(), store = f.create()
  expect(await store.load()).toBeNull()
  await store.save(state())
  expect(f.redis.eval.mock.calls[0][0]).toBe(SAVE_COMPANION_EPOCH)
  expect(f.redis.eval.mock.calls[0][1].arguments[2]).not.toContain('companions')
  expect(SAVE_COMPANION_EPOCH).not.toContain('EXPIRE')
  expect(await f.create().load()).toEqual(state())
})
test('rejects stale saves, lease loss, index regression and identity replacement', async () => {
  const f = setup(), a = f.create(), b = f.create()
  await a.load(); await b.load(); await a.save(state())
  await expect(b.save(state())).rejects.toThrow('state_conflict')
  await expect(a.save({ ...state(), rawId: 11 })).rejects.toThrow('epoch_regression')
  await expect(a.save({ ...state(), currentKeyIndex: 0, companions: [] })).rejects.toThrow('epoch_regression')
  f.loseLease(); await expect(a.save(state())).rejects.toThrow('state_conflict')
})
test('rejects uninitialized saves, invalid scope and duplicate indexes', async () => {
  const f = setup()
  await expect(f.create().save(state())).rejects.toThrow('state_not_loaded')
  expect(() => new MobileCompanionPersistence(f.redis, {} as any, id, '*', 'owner')).toThrow('scope_invalid')
  expect(() => validateCompanionEpoch({ ...state(), companions: [...state().companions, ...state().companions] })).toThrow('state_invalid')
  expect(() => validateCompanionEpoch({ ...state(), currentKeyIndex: -1 })).toThrow('state_invalid')
})
