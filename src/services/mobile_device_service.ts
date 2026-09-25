import { randomUUID } from 'crypto'

export class MobileDeviceError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

export interface MobileDeviceDraft {
  id: string
  phone: string
  name: string
  platform: 'android' | 'ios'
  accountType: 'personal' | 'business'
  connectionMode: 'mobile_primary'
  state: 'draft' | 'deleting'
  createdAt: string
  createdBy: string
}
export interface MobileDraftRedis {
  hGetAll(key: string): Promise<Record<string, string>>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

// Metadata only. Never credentials, OTPs, QR contents or existing session configuration.
export const MOBILE_DRAFTS_KEY = 'mobile-primary:{v1}:drafts'
export const CREATE_MOBILE_DRAFT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
if redis.call('HLEN', KEYS[1]) >= 100 then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`
export const REMOVE_MOBILE_DRAFT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1`

export function mobileCapabilities() {
  return {
    experimental: true,
    draftManagement: true,
    smsRegistration: false,
    credentialImport: false,
    primaryConnection: false,
    companionQr: false,
    companionCode: false,
    voip: false,
    reason: 'mobile_registration_provider_unavailable',
  } as const
}

export function validateMobileDraft(input: unknown) {
  const fail = () => { throw new MobileDeviceError(400, 'mobile_invalid_draft') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
  const data = input as Record<string, unknown>
  if (Object.keys(data).some(key => !['phone', 'name', 'platform', 'accountType', 'labConsent'].includes(key))) return fail()
  if (typeof data.phone !== 'string' || !/^[1-9]\d{7,14}$/.test(data.phone)) return fail()
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(data.name)) return fail()
  if (!['android', 'ios'].includes(data.platform as string) || !['personal', 'business'].includes(data.accountType as string) || data.labConsent !== true) return fail()
  return { phone: data.phone, name: data.name.trim(), platform: data.platform as MobileDeviceDraft['platform'], accountType: data.accountType as MobileDeviceDraft['accountType'] }
}

export class MobileDeviceService {
  constructor(private readonly redis: () => Promise<MobileDraftRedis> = async () => {
    const { getRedis } = await import('./redis.js')
    return await getRedis()
  }) {}

  async list(): Promise<MobileDeviceDraft[]> {
    const rows = await (await this.redis()).hGetAll(MOBILE_DRAFTS_KEY)
    return Object.values(rows).map(raw => JSON.parse(raw) as MobileDeviceDraft).sort((a, b) => a.phone.localeCompare(b.phone))
  }

  async get(id: string): Promise<MobileDeviceDraft> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new MobileDeviceError(404, 'mobile_draft_not_found')
    const draft = (await this.list()).find(item => item.id === id)
    if (!draft) throw new MobileDeviceError(404, 'mobile_draft_not_found')
    if (draft.state === 'deleting') throw new MobileDeviceError(409, 'mobile_deletion_in_progress')
    return draft
  }

  async create(input: unknown, actorId: string): Promise<MobileDeviceDraft> {
    const validated = validateMobileDraft(input)
    const draft: MobileDeviceDraft = { ...validated, id: randomUUID(), connectionMode: 'mobile_primary', state: 'draft', createdAt: new Date().toISOString(), createdBy: actorId }
    const result = Number(await (await this.redis()).eval(CREATE_MOBILE_DRAFT, { keys: [MOBILE_DRAFTS_KEY], arguments: [draft.phone, JSON.stringify(draft)] }))
    if (result === 0) throw new MobileDeviceError(409, 'mobile_phone_already_drafted')
    if (result !== 1) throw new MobileDeviceError(409, 'mobile_draft_limit')
    return draft
  }

  async remove(id: string): Promise<void> {
    const draft = await this.get(id)
    if (draft.state !== 'draft') throw new MobileDeviceError(409, 'mobile_draft_changed')
    const result = Number(await (await this.redis()).eval(REMOVE_MOBILE_DRAFT, { keys: [MOBILE_DRAFTS_KEY, 'mobile-primary:{v1}:registration:' + id], arguments: [draft.phone, JSON.stringify(draft)] }))
    if (result !== 1) throw new MobileDeviceError(409, 'mobile_draft_changed')
  }
}
