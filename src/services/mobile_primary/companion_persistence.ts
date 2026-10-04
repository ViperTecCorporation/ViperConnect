import type { CompanionHostEpochState, CompanionHostPersistence } from 'zapo-js'
import { RegistrationVault } from './registration_vault'
import { MobileDeviceError } from '../mobile_device_service'

export const SAVE_COMPANION_EPOCH = `
if redis.call('GET',KEYS[2]) ~= ARGV[1] then return 0 end
if (redis.call('GET',KEYS[1]) or '') ~= ARGV[2] then return 0 end
redis.call('SET',KEYS[1],ARGV[3])
return 1`

interface EpochRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export function validateCompanionEpoch(state: CompanionHostEpochState): void {
  const validIndex = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
  if (!state || !validIndex(state.rawId) || !validIndex(state.currentKeyIndex) || !Array.isArray(state.companions) || state.companions.length > 100) throw new MobileDeviceError(409, 'mobile_companion_state_invalid')
  const jids = new Set<string>(), indexes = new Set<number>()
  for (const item of state.companions) {
    if (!/^\d+:\d+@s\.whatsapp\.net$/.test(item.deviceJid) || jids.has(item.deviceJid) || !validIndex(item.keyIndex) || item.keyIndex === 0 || item.keyIndex > state.currentKeyIndex || indexes.has(item.keyIndex) || !(item.companionIdentityPublicKey instanceof Uint8Array) || item.companionIdentityPublicKey.length !== 32 || !Number.isSafeInteger(item.addedAtSeconds) || item.addedAtSeconds < 0) throw new MobileDeviceError(409, 'mobile_companion_state_invalid')
    jids.add(item.deviceJid); indexes.add(item.keyIndex)
  }
}

export function serializeCompanionEpoch(state: CompanionHostEpochState) {
  validateCompanionEpoch(state)
  return { ...state, companions: state.companions.map(item => ({ ...item, companionIdentityPublicKey: Buffer.from(item.companionIdentityPublicKey).toString('base64') })) }
}
export function deserializeCompanionEpoch(value: any): CompanionHostEpochState {
  const state = { ...value, companions: value?.companions?.map((item: any) => ({ ...item, companionIdentityPublicKey: new Uint8Array(Buffer.from(item.companionIdentityPublicKey, 'base64')) })) }
  validateCompanionEpoch(state)
  return state
}
/** Encrypted SDK persistence fenced by the CURRENT worker lease token. */
export class MobileCompanionPersistence implements CompanionHostPersistence {
  private snapshot: string | undefined
  private previous?: { rawId: number; currentKeyIndex: number }
  private readonly key: string
  constructor(private redis: EpochRedis, private vault: RegistrationVault, private draftId: string, private phone: string, private leaseToken: string) {
    if (!/^[a-f0-9-]{36}$/.test(draftId) || !/^[1-9]\d{7,14}$/.test(phone) || !leaseToken) throw new MobileDeviceError(400, 'mobile_companion_scope_invalid')
    this.key = `mobile-primary:{v1}:companions:${draftId}`
  }
  async load(): Promise<CompanionHostEpochState | null> {
    const raw = await this.redis.get(this.key)
    if (!raw) { this.snapshot = ''; this.previous = undefined; return null }
    const value: any = this.vault.open(this.key, raw)
    const state = deserializeCompanionEpoch(value)
    validateCompanionEpoch(state)
    this.snapshot = raw; this.previous = { rawId: state.rawId, currentKeyIndex: state.currentKeyIndex }
    return state
  }
  async save(state: CompanionHostEpochState): Promise<void> {
    validateCompanionEpoch(state)
    if (this.snapshot === undefined) throw new MobileDeviceError(409, 'mobile_companion_state_not_loaded')
    if (this.previous && (state.rawId !== this.previous.rawId || state.currentKeyIndex < this.previous.currentKeyIndex)) throw new MobileDeviceError(409, 'mobile_companion_epoch_regression')
    const serialized = { ...state, companions: state.companions.map(item => ({ ...item, companionIdentityPublicKey: Buffer.from(item.companionIdentityPublicKey).toString('base64') })) }
    const next = this.vault.seal(this.key, serialized)
    const saved = await this.redis.eval(SAVE_COMPANION_EPOCH, { keys: [this.key, `unoapi-lease:zapo-session:${this.phone}`], arguments: [this.leaseToken, this.snapshot, next] })
    if (Number(saved) !== 1) throw new MobileDeviceError(409, 'mobile_companion_state_conflict')
    this.snapshot = next; this.previous = { rawId: state.rawId, currentKeyIndex: state.currentKeyIndex }
  }
}
